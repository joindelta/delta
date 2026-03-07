//! Iroh-based P2P networking layer.
//!
//! This module provides:
//! - Iroh endpoint for P2P connectivity (NAT traversal, hole punching)
//! - Custom ALPN protocol for onion routing
//! - iroh-blobs integration for content-addressed blob storage
//! - iroh-gossip for message broadcasting

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use iroh::{Endpoint, EndpointId, SecretKey};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh_gossip::api::{Event as GossipEvent, GossipSender};
use iroh_gossip::net::Gossip;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::task::JoinHandle;
use futures_util::StreamExt;
use p2panda_core::{Body, Header};
use p2panda_store::OperationStore;

use crate::{blobs, ops, sealed_sender, store};

/// ALPN protocol identifier for Gardens's onion routing protocol.
pub const ONION_ALPN: &[u8] = b"/gardens/onion/1.0.0";

/// ALPN protocol identifier for blob requests.
pub const BLOB_ALPN: &[u8] = b"/gardens/blob/1.0.0";

/// Maximum size for onion packets (64KB).
pub const MAX_ONION_PACKET_SIZE: usize = 64 * 1024;

/// Default timeout for P2P operations.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    #[error("Network not initialized")]
    NotInitialized,
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Protocol error: {0}")]
    ProtocolError(String),
    #[error("Stream error: {0}")]
    StreamError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Network state containing all Iroh components.
pub struct NetworkState {
    /// The Iroh endpoint - handles all QUIC connections
    pub endpoint: Endpoint,
    /// Handler task for incoming connections
    #[allow(dead_code)]
    connection_handler: JoinHandle<()>,
    /// Channel for onion packets received for this node
    pub onion_rx: mpsc::UnboundedReceiver<OnionPacket>,
    /// Blob store for content-addressed storage
    pub blob_store: Arc<iroh_blobs::store::fs::FsStore>,
    /// Gossip instance
    pub gossip: Gossip,
    /// Active gossip topics by topic id
    pub gossip_topics: HashMap<[u8; 32], GossipSender>,
}

/// An onion-routed packet received by this node.
pub struct OnionPacket {
    /// The encrypted payload (to be peeled)
    pub payload: Vec<u8>,
    /// Source node ID (the immediate sender)
    pub from_node_id: String,
}

#[derive(Clone, Copy, Debug)]
pub enum GossipTopicKind {
    Room,
    DmInbox,
}

/// Global network state - initialized once on startup.
static NETWORK: RwLock<Option<Arc<Mutex<NetworkState>>>> = RwLock::const_new(None);

/// Get the network state if initialized.
pub async fn get_network() -> Option<Arc<Mutex<NetworkState>>> {
    let guard = NETWORK.read().await;
    guard.clone()
}

/// Check if the network is initialized.
pub async fn is_initialized() -> bool {
    NETWORK.read().await.is_some()
}

/// Initialize the Iroh networking stack.
pub async fn init_network(
    _db_dir: &str,
    relay_url: Option<&str>,
) -> Result<String, NetworkError> {
    // Check if already initialized
    {
        let guard = NETWORK.read().await;
        if guard.is_some() {
            let net = guard.as_ref().unwrap().lock().await;
            return Ok(net.endpoint.id().to_string());
        }
    }

    // Get or create the secret key from the core's private key
    let secret_key = get_or_create_secret_key().await?;

    // Create the endpoint
    let builder = Endpoint::builder()
        .secret_key(secret_key);

    if let Some(url) = relay_url {
        log::info!("[network] Using relay: {}", url);
        // Relay configuration would go here
    }

    let endpoint = builder.bind()
        .await
        .map_err(|e| NetworkError::ConnectionFailed(e.to_string()))?;

    let node_id = endpoint.id();
    log::info!("[network] Iroh endpoint bound, node_id: {}", node_id);
    
    // Store node_id for later use since we can't call node_id() on endpoint after move
    let node_id_string = node_id.to_string();

    // Initialize blob store
    let blob_store_path = blobs::blob_store_path(_db_dir);
    let blob_store = iroh_blobs::store::fs::FsStore::load(blob_store_path)
        .await
        .map_err(|e| NetworkError::IoError(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
    let blob_store = Arc::new(blob_store);

    // Channel for receiving onion packets
    let (onion_tx, onion_rx) = mpsc::unbounded_channel();

    // Spawn gossip
    let gossip = Gossip::builder().spawn(endpoint.clone());

    // Spawn connection handler
    let endpoint_clone = endpoint.clone();
    let gossip_clone = gossip.clone();
    let handler = tokio::spawn(connection_handler(endpoint_clone, gossip_clone, onion_tx));

    let state = NetworkState {
        endpoint,
        connection_handler: handler,
        onion_rx,
        blob_store,
        gossip,
        gossip_topics: HashMap::new(),
    };

    // Store the network state
    {
        let mut guard = NETWORK.write().await;
        *guard = Some(Arc::new(Mutex::new(state)));
    }

    log::info!("[network] Network initialized, node_id: {}", node_id_string);
    Ok(node_id_string)
}

/// Handler for incoming QUIC connections.
async fn connection_handler(
    endpoint: Endpoint,
    gossip: Gossip,
    onion_tx: mpsc::UnboundedSender<OnionPacket>,
) {
    log::info!("[network] Connection handler started");

    while let Some(incoming) = endpoint.accept().await {
        let onion_tx = onion_tx.clone();
        let gossip = gossip.clone();
        
        tokio::spawn(async move {
            match incoming.await {
                Ok(conn) => {
                    if let Err(e) = handle_connection(conn, &gossip, onion_tx).await {
                        log::warn!("[network] Connection handling error: {}", e);
                    }
                }
                Err(e) => {
                    log::warn!("[network] Failed to accept connection: {}", e);
                }
            }
        });
    }

    log::info!("[network] Connection handler stopped");
}

/// Handle a single connection based on its ALPN.
async fn handle_connection(
    conn: Connection,
    gossip: &Gossip,
    onion_tx: mpsc::UnboundedSender<OnionPacket>,
) -> Result<(), NetworkError> {
    let alpn = conn.alpn();
    
    log::debug!("[network] New connection with ALPN: {:?}", alpn);

    match alpn.as_deref() {
        Some(a) if a == ONION_ALPN => handle_onion_connection(conn, onion_tx).await,
        Some(a) if a == BLOB_ALPN => handle_blob_connection(conn).await,
        Some(a) if a == iroh_gossip::net::GOSSIP_ALPN => {
            gossip
                .handle_connection(conn)
                .await
                .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
            Ok(())
        }
        _ => {
            log::warn!("[network] Unknown ALPN: {:?}", alpn);
            Ok(())
        }
    }
}

/// Handle connections using the onion routing protocol.
async fn handle_onion_connection(
    conn: Connection,
    onion_tx: mpsc::UnboundedSender<OnionPacket>,
) -> Result<(), NetworkError> {
    let remote_node_id = match conn.remote_id() {
        Ok(id) => id,
        Err(e) => {
            log::warn!("[network] Could not get remote node id: {}", e);
            return Ok(());
        }
    };

    // Accept bi-directional streams
    loop {
        match conn.accept_bi().await {
            Ok((send, recv)) => {
                let onion_tx = onion_tx.clone();
                let from = remote_node_id;
                
                tokio::spawn(async move {
                    if let Err(e) = handle_onion_stream(send, recv, from, onion_tx).await {
                        log::warn!("[network] Onion stream error: {}", e);
                    }
                });
            }
            Err(e) => {
                log::warn!("[network] Accept bi error: {}", e);
                break;
            }
        }
    }

    Ok(())
}

/// Handle a single onion routing stream.
async fn handle_onion_stream(
    _send: SendStream,
    mut recv: RecvStream,
    from: EndpointId,
    onion_tx: mpsc::UnboundedSender<OnionPacket>,
) -> Result<(), NetworkError> {
    // Read the packet size (4 bytes, big-endian)
    let mut size_buf = [0u8; 4];
    recv.read_exact(&mut size_buf).await
        .map_err(|e| NetworkError::StreamError(e.to_string()))?;
    
    let size = u32::from_be_bytes(size_buf) as usize;
    
    if size > MAX_ONION_PACKET_SIZE {
        return Err(NetworkError::ProtocolError(
            format!("Packet too large: {} bytes", size)
        ));
    }

    // Read the encrypted payload
    let mut payload = vec![0u8; size];
    recv.read_exact(&mut payload).await
        .map_err(|e| NetworkError::StreamError(e.to_string()))?;

    // Send to processing channel
    let packet = OnionPacket {
        payload,
        from_node_id: from.to_string(),
    };
    onion_tx.send(packet)
        .map_err(|_| NetworkError::ProtocolError("Failed to queue packet".to_string()))?;

    Ok(())
}

/// Handle connections for blob transfers.
async fn handle_blob_connection(_conn: Connection) -> Result<(), NetworkError> {
    log::debug!("[network] Blob connection established");
    Ok(())
}

/// Send an onion packet to the next hop.
pub async fn send_onion_packet(
    next_hop: &str,
    encrypted_payload: Vec<u8>,
) -> Result<(), NetworkError> {
    let network = get_network().await
        .ok_or(NetworkError::NotInitialized)?;
    
    let net = network.lock().await;
    
    // Parse the destination node ID
    let node_id: EndpointId = next_hop.parse()
        .map_err(|e| NetworkError::ProtocolError(format!("Invalid node ID: {}", e)))?;

    // Connect with our custom ALPN
    let conn = net.endpoint.connect(node_id, ONION_ALPN).await
        .map_err(|e| NetworkError::ConnectionFailed(e.to_string()))?;

    // Open a bi-directional stream
    let (mut send, _recv) = conn.open_bi().await
        .map_err(|e| NetworkError::StreamError(e.to_string()))?;

    // Send packet size (4 bytes, big-endian)
    let size = encrypted_payload.len() as u32;
    send.write_all(&size.to_be_bytes())
        .await
        .map_err(|e| NetworkError::StreamError(e.to_string()))?;

    // Send the encrypted payload
    send.write_all(&encrypted_payload)
        .await
        .map_err(|e| NetworkError::StreamError(e.to_string()))?;
    send.finish()
        .map_err(|e| NetworkError::StreamError(e.to_string()))?;

    log::debug!("[network] Onion packet sent to {}", next_hop);
    Ok(())
}

pub async fn gossip_publish(
    topic_id: [u8; 32],
    kind: GossipTopicKind,
    bootstrap: Vec<EndpointId>,
    bytes: Vec<u8>,
) -> Result<(), NetworkError> {
    let network = get_network().await.ok_or(NetworkError::NotInitialized)?;
    let mut net = network.lock().await;
    let sender = ensure_gossip_topic(&mut *net, topic_id, kind, bootstrap).await?;
    sender
        .broadcast(bytes.into())
        .await
        .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
    Ok(())
}

pub async fn gossip_join(
    topic_id: [u8; 32],
    kind: GossipTopicKind,
    bootstrap: Vec<EndpointId>,
) -> Result<(), NetworkError> {
    let network = get_network().await.ok_or(NetworkError::NotInitialized)?;
    let mut net = network.lock().await;
    let _ = ensure_gossip_topic(&mut *net, topic_id, kind, bootstrap).await?;
    Ok(())
}

async fn ensure_gossip_topic(
    net: &mut NetworkState,
    topic_id: [u8; 32],
    kind: GossipTopicKind,
    bootstrap: Vec<EndpointId>,
) -> Result<GossipSender, NetworkError> {
    if let Some(sender) = net.gossip_topics.get(&topic_id) {
        return Ok(sender.clone());
    }

    let topic = net
        .gossip
        .subscribe(iroh_gossip::TopicId::from(topic_id), bootstrap)
        .await
        .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
    let (sender, mut receiver) = topic.split();
    let kind_copy = kind;
    tokio::spawn(async move {
        while let Some(event) = receiver.next().await {
            match event {
                Ok(GossipEvent::Received(msg)) => {
                    if let Err(e) = handle_gossip_message(kind_copy, msg.content.to_vec()).await {
                        log::warn!("[network] Gossip ingest failed: {}", e);
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("[network] Gossip receive error: {}", e);
                }
            }
        }
    });

    net.gossip_topics.insert(topic_id, sender.clone());
    Ok(sender)
}

async fn handle_gossip_message(kind: GossipTopicKind, bytes: Vec<u8>) -> Result<(), NetworkError> {
    let payload = match kind {
        GossipTopicKind::Room => bytes,
        GossipTopicKind::DmInbox => {
            if sealed_sender::is_sealed(&bytes) {
                let core = store::get_core().ok_or(NetworkError::NotInitialized)?;
                let seed = *core.private_key.as_bytes();
                let (_sender_pk, op_bytes) = sealed_sender::open(&bytes, &seed)
                    .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
                op_bytes
            } else {
                bytes
            }
        }
    };

    ingest_gossip_envelope(&payload).await
}

async fn ingest_gossip_envelope(bytes: &[u8]) -> Result<(), NetworkError> {
    let core = store::get_core().ok_or(NetworkError::NotInitialized)?;
    let env = ops::decode_cbor::<ops::GossipEnvelope>(bytes)
        .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
    let header = Header::try_from(env.header_bytes.as_slice())
        .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
    let body = Body::new(&env.body_bytes);
    let op_hash = header.hash();

    let mut store = core.op_store.lock().await;
    store
        .insert_operation(op_hash, &header, Some(&body), &env.header_bytes, &env.log_id)
        .await
        .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
    Ok(())
}

/// Get our node ID as a string.
pub async fn get_node_id() -> Result<String, NetworkError> {
    let network = get_network().await
        .ok_or(NetworkError::NotInitialized)?;
    
    let net = network.lock().await;
    Ok(net.endpoint.id().to_string())
}

/// Get or create the node's secret key.
async fn get_or_create_secret_key() -> Result<SecretKey, NetworkError> {
    let core = store::get_core()
        .ok_or(NetworkError::NotInitialized)?;
    
    // Convert p2panda private key to Iroh secret key
    let p2panda_bytes = hex::decode(core.private_key.to_hex())
        .map_err(|e| NetworkError::ProtocolError(e.to_string()))?;
    
    if p2panda_bytes.len() != 32 {
        return Err(NetworkError::ProtocolError("Invalid private key length".to_string()));
    }

    // Create Iroh secret key from the same seed
    let key_bytes: [u8; 32] = p2panda_bytes.try_into()
        .map_err(|_| NetworkError::ProtocolError("Invalid key conversion".to_string()))?;
    
    let secret_key = SecretKey::from_bytes(&key_bytes);
    
    Ok(secret_key)
}

/// Shutdown the network layer.
pub async fn shutdown_network() {
    let mut guard = NETWORK.write().await;
    if let Some(net) = guard.take() {
        let net = net.lock().await;
        net.endpoint.close().await;
        log::info!("[network] Network shutdown complete");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_node_id_parsing() {
        // Test that we can parse node IDs correctly
        let id_str = "ae58c67e4e034e4ae26f17c13c25b6b7c5a7cc7b7d78380d1f5e1c1a1b1c1d1e";
        let result: Result<EndpointId, _> = id_str.parse();
        assert!(result.is_ok());
    }
}

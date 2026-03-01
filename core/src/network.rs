//! Phase 3 — p2panda-net integration.

use std::collections::HashMap;
use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::{Arc, OnceLock};

use futures_util::StreamExt;
use p2panda_store::OperationStore;
use p2panda_core::{Hash, PrivateKey, PublicKey};
use p2panda_net::addrs::NodeInfo;
use p2panda_net::iroh_endpoint::from_public_key;
use p2panda_net::iroh_mdns::MdnsDiscoveryMode;
use p2panda_net::gossip::GossipHandle;
use p2panda_net::{AddressBook, Discovery, Endpoint, Gossip, LogSync, MdnsDiscovery, TopicId};
use p2panda_sync::protocols::Logs;
use p2panda_sync::traits::TopicMap;
use tokio::sync::RwLock;

use crate::sealed_sender;
use crate::store::{DeltaStore, get_core};

// ─── Topic derivation ─────────────────────────────────────────────────────────

/// Namespaced prefix prevents collision with other p2panda apps.
const ORG_PREFIX:       &[u8] = b"delta:org:";
const ROOM_PREFIX:      &[u8] = b"delta:room:";
const DM_PREFIX:        &[u8] = b"delta:dm:";
const DISCOVER_PREFIX:  &[u8] = b"delta:discover:";

pub fn topic_id_for_org(org_id: &str) -> [u8; 32] {
    topic_hash(&[ORG_PREFIX, org_id.as_bytes()])
}

pub fn topic_id_for_room(room_id: &str) -> [u8; 32] {
    topic_hash(&[ROOM_PREFIX, room_id.as_bytes()])
}

/// DM topic is symmetric: both parties derive the same ID regardless of order.
pub fn topic_id_for_dm(key_a: &str, key_b: &str) -> [u8; 32] {
    let (lo, hi) = if key_a <= key_b { (key_a, key_b) } else { (key_b, key_a) };
    topic_hash(&[DM_PREFIX, lo.as_bytes(), b":", hi.as_bytes()])
}

pub fn topic_id_for_discovery(name: &str) -> [u8; 32] {
    let normalized = name.to_lowercase();
    topic_hash(&[DISCOVER_PREFIX, normalized.as_bytes()])
}

fn topic_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut buf = Vec::new();
    for p in parts { buf.extend_from_slice(p); }
    *Hash::new(&buf).as_bytes()
}

// ─── DeltaTopicMap ────────────────────────────────────────────────────────────

/// Log identifier — a String matching how DeltaStore<String, ()> identifies logs.
pub type LogId = String;

/// Maps a `TopicId` ([u8; 32]) to the set of author logs that belong to that
/// topic.  The inner map is `TopicId → HashMap<author PublicKey, Vec<LogId>>`,
/// which is exactly the `Logs<LogId>` type expected by `TopicLogSync`.
///
/// `DeltaTopicMap` is cheaply `Clone` (it wraps an `Arc`) and supports runtime
/// mutation so that callers can register new rooms, orgs or DM threads after
/// the network has started.
#[derive(Clone, Default, Debug)]
pub struct DeltaTopicMap(Arc<RwLock<HashMap<TopicId, Logs<LogId>>>>);

impl DeltaTopicMap {
    /// Create an empty topic map.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `(author, log_id)` under the given topic.
    ///
    /// Calling this multiple times for the same topic accumulates logs rather
    /// than replacing them.
    pub async fn insert(&self, topic_id: TopicId, author: PublicKey, log_id: LogId) {
        let mut map = self.0.write().await;
        map.entry(topic_id)
            .and_modify(|logs| {
                logs.entry(author).or_default().push(log_id.clone());
            })
            .or_insert_with(|| {
                let mut logs: Logs<LogId> = HashMap::new();
                logs.insert(author, vec![log_id]);
                logs
            });
    }

    /// Remove all log entries for a topic (e.g. when leaving a room).
    pub async fn remove(&self, topic_id: &TopicId) {
        self.0.write().await.remove(topic_id);
    }
}

/// `TopicMap<TopicId, Logs<LogId>>` is the trait required by `TopicLogSync`
/// (used internally by `LogSync::builder`).  We return an empty `Logs` for
/// unknown topics so sync sessions degrade gracefully rather than failing.
impl TopicMap<TopicId, Logs<LogId>> for DeltaTopicMap {
    type Error = Infallible;

    async fn get(&self, topic: &TopicId) -> Result<Logs<LogId>, Self::Error> {
        let map = self.0.read().await;
        Ok(map.get(topic).cloned().unwrap_or_default())
    }
}

// ─── Error type ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct NetworkError(pub String);

impl std::fmt::Display for NetworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "network error: {}", self.0)
    }
}

impl std::error::Error for NetworkError {}

// ─── DiscoveryAnnounce ────────────────────────────────────────────────────────

/// CBOR payload broadcast by public orgs on their discovery topic.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DiscoveryAnnounce {
    pub org_id: String,
    pub name: String,
    pub type_label: String,
    pub description: Option<String>,
    pub creator_key: String,
    pub created_at: i64,
}

// ─── NetworkCore singleton ────────────────────────────────────────────────────

/// Type alias for our concrete LogSync instantiation.
type DeltaLogSync = LogSync<DeltaStore, LogId, (), DeltaTopicMap>;

/// Holds all live p2panda-net handles. Stored in a `OnceLock` so that the rest
/// of the crate can cheaply access the running network without passing handles
/// through every call-stack frame.
pub struct NetworkCore {
    pub address_book: AddressBook,
    pub endpoint: Endpoint,
    pub gossip: Gossip,
    pub log_sync: DeltaLogSync,
    pub topic_map: DeltaTopicMap,
    /// Tracks which `TopicId`s we have already passed to `log_sync.stream()`,
    /// so that `subscribe_topic_inner` remains idempotent.
    subscribed: Arc<RwLock<HashSet<TopicId>>>,
    // Keep discovery and mdns alive for the lifetime of NetworkCore.
    _discovery: Discovery,
    _mdns: MdnsDiscovery,
    /// Gossip handles keyed by TopicId — kept alive so the overlay subscription
    /// is not dropped, and used for topic-targeted publish.
    pub gossip_handles: Arc<tokio::sync::Mutex<HashMap<TopicId, GossipHandle>>>,
    /// Our Ed25519 seed bytes — needed in the gossip drain to open sealed-sender
    /// DM envelopes.
    pub my_seed_bytes: [u8; 32],
}

static NETWORK: OnceLock<NetworkCore> = OnceLock::new();

/// Returns the live `NetworkCore` if `init_network()` has been called.
pub fn get_network() -> Option<&'static NetworkCore> {
    NETWORK.get()
}

// ─── Initialisation ───────────────────────────────────────────────────────────

/// Build all p2panda-net subsystems and store them in the global singleton.
///
/// Called once from `store::bootstrap()` after the operation store and read
/// model are ready.
pub async fn init_network(
    private_key_hex: &str,
    _db_dir: &str,
    bootstrap_nodes: Vec<crate::BootstrapNode>,
    read_pool: &sqlx::SqlitePool,
) -> Result<(), NetworkError> {
    // Idempotent — if already initialised just return.
    if NETWORK.get().is_some() {
        return Ok(());
    }

    // ── 1. Parse private key ──────────────────────────────────────────────────
    let key_bytes = hex::decode(private_key_hex)
        .map_err(|e| NetworkError(format!("bad private key hex: {e}")))?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| NetworkError("private key must be 32 bytes".into()))?;
    let private_key = PrivateKey::from_bytes(&key_array);
    let my_public_key = private_key.public_key();

    // ── 2. Address book ──────────────────────────────────────────────────────
    let address_book = AddressBook::builder()
        .spawn()
        .await
        .map_err(|e| NetworkError(format!("address book: {e}")))?;

    // Add bootstrap nodes supplied by the caller.
    for bn in &bootstrap_nodes {
        let node_id: PublicKey = bn
            .node_id_hex
            .parse()
            .map_err(|e| NetworkError(format!("bad bootstrap node id '{}': {e}", bn.node_id_hex)))?;

        let iroh_node_id = from_public_key(node_id);
        let mut endpoint_addr = iroh::EndpointAddr::new(iroh_node_id);

        if !bn.relay_url.is_empty() {
            let relay: iroh::RelayUrl = bn
                .relay_url
                .parse()
                .map_err(|e| NetworkError(format!("bad relay url '{}': {e}", bn.relay_url)))?;
            endpoint_addr = endpoint_addr.with_relay_url(relay);
        }

        let node_info = NodeInfo::from(endpoint_addr).bootstrap();
        address_book
            .insert_node_info(node_info)
            .await
            .map_err(|e| NetworkError(format!("insert bootstrap node: {e}")))?;
    }

    // ── 3. Endpoint ──────────────────────────────────────────────────────────
    let endpoint = Endpoint::builder(address_book.clone())
        .private_key(private_key)
        .spawn()
        .await
        .map_err(|e| NetworkError(format!("endpoint: {e}")))?;

    // ── 4. Discovery ─────────────────────────────────────────────────────────
    let discovery = Discovery::builder(address_book.clone(), endpoint.clone())
        .spawn()
        .await
        .map_err(|e| NetworkError(format!("discovery: {e}")))?;

    // ── 5. mDNS (passive — no LAN beacon, just listen) ───────────────────────
    let mdns = MdnsDiscovery::builder(address_book.clone(), endpoint.clone())
        .mode(MdnsDiscoveryMode::Passive)
        .spawn()
        .await
        .map_err(|e| NetworkError(format!("mdns: {e}")))?;

    // ── 6. Gossip ────────────────────────────────────────────────────────────
    let gossip = Gossip::builder(address_book.clone(), endpoint.clone())
        .spawn()
        .await
        .map_err(|e| NetworkError(format!("gossip: {e}")))?;

    // ── 7. Topic map ──────────────────────────────────────────────────────────
    let topic_map = DeltaTopicMap::new();

    // ── 8. Op store ───────────────────────────────────────────────────────────
    // Clone the DeltaStore from the global CORE.
    // DeltaStore (SqliteStore) is Clone — it wraps a connection pool Arc.
    let op_store: DeltaStore = {
        let core = get_core()
            .ok_or_else(|| NetworkError("core not initialised before network".into()))?;
        core.op_store.lock().await.clone()
    };

    // ── 9. LogSync ───────────────────────────────────────────────────────────
    let log_sync: DeltaLogSync = LogSync::builder(
        op_store,
        topic_map.clone(),
        endpoint.clone(),
        gossip.clone(),
    )
    .spawn()
    .await
    .map_err(|e| NetworkError(format!("log sync: {e}")))?;

    // ── 10. Build NetworkCore ─────────────────────────────────────────────────
    let core = NetworkCore {
        address_book,
        endpoint,
        gossip,
        log_sync,
        topic_map,
        subscribed: Arc::new(RwLock::new(HashSet::new())),
        _discovery: discovery,
        _mdns: mdns,
        gossip_handles: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        my_seed_bytes: key_array,
    };

    NETWORK
        .set(core)
        .map_err(|_| NetworkError("network already initialised".into()))?;

    // ── 11. Subscribe to topics we already know about from the read model ─────
    subscribe_initial_topics(my_public_key, read_pool).await?;

    Ok(())
}

// ─── Internal subscription helpers ───────────────────────────────────────────

/// Subscribe to a topic on both the gossip overlay and the sync protocol.
///
/// Idempotent: calling with the same `TopicId` twice is a no-op after the
/// first successful subscription.
async fn subscribe_topic_inner(topic_id: TopicId) -> Result<(), NetworkError> {
    let net = match get_network() {
        Some(n) => n,
        None => return Ok(()), // network not yet up; silently skip
    };

    // Check idempotency.
    {
        let subscribed = net.subscribed.read().await;
        if subscribed.contains(&topic_id) {
            return Ok(());
        }
    }

    // Join gossip overlay for this topic.
    let gossip_handle = net
        .gossip
        .stream(topic_id)
        .await
        .map_err(|e| NetworkError(format!("gossip stream: {e}")))?;

    // Spawn a drain task for incoming gossip messages.
    {
        let mut gossip_rx = gossip_handle.subscribe();
        // Capture seed bytes so the drain can open sealed-sender envelopes.
        let my_seed = net.my_seed_bytes;
        tokio::spawn(async move {
            while let Some(Ok(bytes)) = gossip_rx.next().await {
                // Determine the actual op bytes — open sealed envelope if needed.
                let op_bytes: Vec<u8> = if sealed_sender::is_sealed(&bytes) {
                    match sealed_sender::open(&bytes, &my_seed) {
                        Ok((_sender_pk, inner)) => inner,
                        Err(_) => continue, // not addressed to us, or tampered
                    }
                } else {
                    bytes
                };

                // Decode the GossipEnvelope.
                let env = match crate::ops::decode_cbor::<crate::ops::GossipEnvelope>(&op_bytes) {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                // Decode the p2panda Header.
                let header = match p2panda_core::Header::try_from(env.header_bytes.as_slice()) {
                    Ok(h) => h,
                    Err(_) => continue,
                };
                let body = p2panda_core::Body::new(&env.body_bytes);
                let op_hash = header.hash();

                // Insert into the op store; the projector picks it up within 500 ms.
                // Duplicate inserts are silently ignored.
                if let Some(core) = crate::store::get_core() {
                    let mut store = core.op_store.lock().await;
                    let _ = store
                        .insert_operation(op_hash, &header, Some(&body), &env.header_bytes, &env.log_id)
                        .await;
                }
            }
        });
    }
    // Keep handle alive (keyed by topic) so the TopicDropGuard is not dropped.
    net.gossip_handles.lock().await.insert(topic_id, gossip_handle);

    // Subscribe via log sync (live_mode = true).
    let sync_handle = net
        .log_sync
        .stream(topic_id, true)
        .await
        .map_err(|e| NetworkError(format!("log sync stream: {e}")))?;
    // Dropping sync_handle would unsubscribe from the topic, so intentionally
    // leak it to keep the sync session alive for the network's lifetime.
    std::mem::forget(sync_handle);

    // Mark as subscribed.
    net.subscribed.write().await.insert(topic_id);

    Ok(())
}

/// Subscribe to an organisation's meta topic and its discovery topic.
pub async fn subscribe_org_meta(org_id: &str) -> Result<(), NetworkError> {
    subscribe_topic_inner(topic_id_for_org(org_id)).await?;
    subscribe_topic_inner(topic_id_for_discovery(org_id)).await?;
    Ok(())
}

/// Subscribe to a room's sync topic.
async fn subscribe_room_inner(room_id: &str) -> Result<(), NetworkError> {
    subscribe_topic_inner(topic_id_for_room(room_id)).await
}

/// On startup, load every org and room the local user is a member of from the
/// read model and subscribe to their topics. This catches up with local state
/// accumulated while offline.
async fn subscribe_initial_topics(
    my_public_key: PublicKey,
    read_pool: &sqlx::SqlitePool,
) -> Result<(), NetworkError> {
    let my_key_hex = my_public_key.to_hex();

    // Subscribe to all orgs we belong to.
    let orgs = crate::db::list_orgs_for_member(read_pool, &my_key_hex)
        .await
        .map_err(|e| NetworkError(format!("list orgs: {e}")))?;

    for org in &orgs {
        subscribe_org_meta(&org.org_id).await?;

        // Subscribe to each room in this org.
        let rooms = crate::db::list_rooms(read_pool, &org.org_id, false)
            .await
            .map_err(|e| NetworkError(format!("list rooms: {e}")))?;

        for room in &rooms {
            subscribe_room_inner(&room.room_id).await?;
        }
    }

    Ok(())
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Returns the current connection status.
///
/// Returns `Online` once the `NetworkCore` singleton has been initialised.
pub fn connection_status() -> crate::ConnectionStatus {
    if NETWORK.get().is_some() {
        crate::ConnectionStatus::Online
    } else {
        crate::ConnectionStatus::Offline
    }
}

/// Subscribe to a room's sync and gossip topics.
pub async fn subscribe_room(room_id: &str) -> Result<(), NetworkError> {
    subscribe_room_inner(room_id).await
}

/// Called from lib.rs with both participant keys already resolved from the read model.
pub async fn subscribe_dm_thread(key_a: &str, key_b: &str) -> Result<(), NetworkError> {
    let topic = topic_id_for_dm(key_a, key_b);
    subscribe_topic_inner(topic).await
}

/// Search for public organisations by querying the discovery gossip topic.
pub async fn search_public_orgs(query: &str) -> Result<Vec<crate::db::OrgRow>, NetworkError> {
    use std::time::Duration;

    let net = match NETWORK.get() {
        Some(n) => n,
        None => return Ok(vec![]),
    };

    let topic_bytes = topic_id_for_discovery(query);
    let topic_id = p2panda_net::TopicId::from(topic_bytes);

    let handle = net
        .gossip
        .stream(topic_id)
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    let mut rx = handle.subscribe();
    let mut results: Vec<crate::db::OrgRow> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

    loop {
        match tokio::time::timeout_at(deadline, rx.next()).await {
            Ok(Some(Ok(bytes))) => {
                if let Ok(org) = crate::ops::decode_cbor::<DiscoveryAnnounce>(&bytes) {
                    results.push(crate::db::OrgRow {
                        org_id: org.org_id,
                        name: org.name,
                        type_label: org.type_label,
                        description: org.description,
                        avatar_blob_id: None,
                        cover_blob_id: None,
                        is_public: 1,
                        creator_key: org.creator_key,
                        created_at: org.created_at,
                    });
                }
            }
            _ => break,
        }
    }

    // Keep gossip handle alive for the duration of search (dropped here = leaves topic after search)
    drop(handle);
    Ok(results)
}

/// Publish bytes on all subscribed gossip topics (used for discovery announcements
/// and other non-DM ops where a specific topic handle is not required).
pub async fn gossip_op(_log_id: &str, op_bytes: &[u8]) {
    let net = match NETWORK.get() {
        Some(n) => n,
        None => return,
    };
    let handles = net.gossip_handles.lock().await;
    for handle in handles.values() {
        let _ = handle.publish(op_bytes.to_vec()).await;
    }
}

/// Publish `bytes` on the specific gossip topic we're subscribed to.
/// No-op if we are not subscribed to `topic_id`.
pub async fn gossip_plain(topic_id: TopicId, bytes: Vec<u8>) {
    let net = match NETWORK.get() {
        Some(n) => n,
        None => return,
    };
    let handles = net.gossip_handles.lock().await;
    if let Some(handle) = handles.get(&topic_id) {
        let _ = handle.publish(bytes).await;
    }
}

/// Convenience wrapper: gossip on a specific topic.
pub async fn gossip_on_topic(topic_bytes: [u8; 32], bytes: Vec<u8>) {
    gossip_plain(topic_bytes, bytes).await;
}

/// Gossip on an organization's meta topic (used for membership ops, etc.).
pub async fn gossip_on_org(org_id: &str) {
    // Membership ops are small — LogSync will propagate them; no gossip needed here.
    let _ = org_id;
}

/// Seal `gossip_bytes` (a CBOR-encoded [`GossipEnvelope`]) for `recipient_pk_bytes`
/// and publish the sealed envelope on the shared DM topic.
///
/// The relay/gossip peers only ever see opaque ciphertext; only the recipient
/// with the matching seed can open the envelope and recover the sender identity.
///
/// Returns `Ok(())` silently if the network is not yet up — the op is already
/// in the local store and will be synced via LogSync when connectivity resumes.
pub async fn gossip_dm_sealed(
    gossip_bytes: &[u8],
    sender_key_hex: &str,
    sender_pk_bytes: &[u8; 32],
    recipient_key_hex: &str,
    recipient_pk_bytes: &[u8; 32],
) -> Result<(), NetworkError> {
    let net = match NETWORK.get() {
        Some(n) => n,
        None => return Ok(()),
    };

    let envelope = sealed_sender::seal(gossip_bytes, sender_pk_bytes, recipient_pk_bytes)
        .map_err(|e| NetworkError(format!("seal: {e}")))?;

    let topic_id: TopicId = topic_id_for_dm(sender_key_hex, recipient_key_hex);

    let handles = net.gossip_handles.lock().await;
    if let Some(handle) = handles.get(&topic_id) {
        let _ = handle.publish(envelope).await;
    }
    // If we're not subscribed to this topic yet the op is in the store and
    // will be synced when both peers are on the topic.

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── topic derivation ──────────────────────────────────────────────────────

    #[test]
    fn org_topic_is_deterministic() {
        let id = "abc123";
        assert_eq!(topic_id_for_org(id), topic_id_for_org(id));
    }

    #[test]
    fn room_topic_differs_from_org_topic() {
        let id = "abc123";
        assert_ne!(topic_id_for_org(id), topic_id_for_room(id));
    }

    #[test]
    fn dm_topic_is_symmetric() {
        let a = "aaaa";
        let b = "bbbb";
        assert_eq!(topic_id_for_dm(a, b), topic_id_for_dm(b, a));
    }

    #[test]
    fn dm_topic_differs_for_different_pairs() {
        assert_ne!(
            topic_id_for_dm("aaaa", "bbbb"),
            topic_id_for_dm("aaaa", "cccc"),
        );
    }

    #[test]
    fn discovery_topic_is_case_insensitive() {
        assert_eq!(
            topic_id_for_discovery("Rustaceans"),
            topic_id_for_discovery("rustaceans"),
        );
    }

    // ── DeltaTopicMap ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn topic_map_unknown_topic_returns_empty_logs() {
        let map = DeltaTopicMap::new();
        let unknown: TopicId = [0u8; 32];
        let logs = map.get(&unknown).await.unwrap();
        assert!(logs.is_empty());
    }

    #[tokio::test]
    async fn topic_map_insert_and_retrieve() {
        let map = DeltaTopicMap::new();
        let topic = topic_id_for_room("room-1");

        // Build a fake author public key from a known private key.
        let private_key = p2panda_core::PrivateKey::new();
        let author = private_key.public_key();

        map.insert(topic, author, "1".to_string()).await;

        let logs = map.get(&topic).await.unwrap();
        assert_eq!(logs.get(&author), Some(&vec!["1".to_string()]));
    }

    #[tokio::test]
    async fn topic_map_accumulates_logs_for_same_author() {
        let map = DeltaTopicMap::new();
        let topic = topic_id_for_room("room-2");
        let private_key = p2panda_core::PrivateKey::new();
        let author = private_key.public_key();

        map.insert(topic, author, "1".to_string()).await;
        map.insert(topic, author, "2".to_string()).await;

        let logs = map.get(&topic).await.unwrap();
        let mut ids = logs.get(&author).unwrap().clone();
        ids.sort();
        assert_eq!(ids, vec!["1".to_string(), "2".to_string()]);
    }

    #[tokio::test]
    async fn topic_map_remove_clears_topic() {
        let map = DeltaTopicMap::new();
        let topic = topic_id_for_room("room-3");
        let private_key = p2panda_core::PrivateKey::new();
        let author = private_key.public_key();

        map.insert(topic, author, "1".to_string()).await;
        map.remove(&topic).await;

        let logs = map.get(&topic).await.unwrap();
        assert!(logs.is_empty());
    }

    #[tokio::test]
    async fn topic_map_clone_shares_state() {
        let map = DeltaTopicMap::new();
        let clone = map.clone();

        let topic = topic_id_for_org("org-1");
        let private_key = p2panda_core::PrivateKey::new();
        let author = private_key.public_key();

        map.insert(topic, author, "42".to_string()).await;

        // The clone should see the same insertion because they share the Arc.
        let logs = clone.get(&topic).await.unwrap();
        assert_eq!(logs.get(&author), Some(&vec!["42".to_string()]));
    }
}

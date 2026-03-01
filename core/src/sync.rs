//! Incoming op ingestion from the Sync Worker WebSocket.
//!
//! React Native manages the WebSocket connection. When an op arrives,
//! RN calls `ingest_op(topic_hex, seq, op_bytes)` which inserts it into
//! the DeltaStore. The projector picks it up within 500ms.

use crate::ops::{decode_cbor, GossipEnvelope};
use crate::store::get_core;
use p2panda_core::{Body, Header};
use p2panda_store::OperationStore;

#[derive(Debug)]
pub struct SyncError(pub String);

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sync error: {}", self.0)
    }
}

impl std::error::Error for SyncError {}

/// Convert 32 raw bytes to a 64-char lowercase hex string.
pub fn bytes_to_hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Ingest a raw op received from the DO WebSocket.
///
/// `topic_hex` — 64-char hex topic ID (for seq tracking)
/// `seq`       — the DO sequence number for this op
/// `op_bytes`  — raw GossipEnvelope CBOR bytes
pub async fn ingest_op(topic_hex: &str, seq: i64, op_bytes: &[u8]) -> Result<(), SyncError> {
    let core = get_core().ok_or_else(|| SyncError("core not initialised".into()))?;

    // Decode GossipEnvelope CBOR
    let env = decode_cbor::<GossipEnvelope>(op_bytes)
        .map_err(|e| SyncError(format!("decode: {e}")))?;

    let header = Header::try_from(env.header_bytes.as_slice())
        .map_err(|e| SyncError(format!("header: {e}")))?;
    let body = Body::new(&env.body_bytes);
    let op_hash = header.hash();

    // Insert into store — duplicate inserts are silently ignored
    {
        let mut store = core.op_store.lock().await;
        store
            .insert_operation(op_hash, &header, Some(&body), &env.header_bytes, &env.log_id)
            .await
            .map_err(|e| SyncError(format!("insert: {e}")))?;
    }

    // Update last-seen seq for this topic
    crate::db::set_topic_seq(&core.read_pool, topic_hex, seq)
        .await
        .map_err(|e| SyncError(format!("seq: {e}")))?;

    Ok(())
}

/// Get the last-seen seq for a topic (for the WebSocket `since` parameter).
pub async fn get_topic_seq(topic_hex: &str) -> Result<i64, SyncError> {
    let core = get_core().ok_or_else(|| SyncError("core not initialised".into()))?;
    crate::db::get_topic_seq(&core.read_pool, topic_hex)
        .await
        .map_err(|e| SyncError(format!("seq: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_hex_roundtrip() {
        let topic: [u8; 32] = [0xab; 32];
        let hex = bytes_to_hex(&topic);
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(hex.starts_with("ab"));
    }
}

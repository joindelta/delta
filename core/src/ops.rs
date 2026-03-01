//! Op payload types and the helper that signs + stores a new operation.
//!
//! Each variant is serialised to CBOR (via ciborium) and stored as the
//! `Body` bytes of a p2panda-core `Operation`.  The Projector decodes them
//! back on the read side.

use std::time::{SystemTime, UNIX_EPOCH};

use ciborium::{from_reader, into_writer};
use p2panda_core::{Body, Hash, Header, PrivateKey};
use p2panda_store::{LogStore, OperationStore};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::store::DeltaStore;

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum OpsError {
    #[error("CBOR encode error: {0}")]
    CborEncode(String),
    #[error("CBOR decode error: {0}")]
    CborDecode(String),
    #[error("store error: {0}")]
    Store(String),
    #[error("system time error")]
    SystemTime,
}

// ─── Log IDs ─────────────────────────────────────────────────────────────────

/// Stable string constants used as the `log_id` in p2panda-store.
/// Each author maintains a separate append-only log per type.
pub mod log_ids {
    pub const PROFILE: &str = "profile";
    pub const ORG: &str = "org";
    pub const ROOM: &str = "room";
    pub const MESSAGE: &str = "message";
    pub const REACTION: &str = "reaction";
    pub const DM_THREAD: &str = "dm_thread";

    // Phase 4 encryption
    pub const KEY_BUNDLE: &str = "key_bundle";
    pub const ENC_CTRL:   &str = "enc_ctrl";
    pub const ENC_DIRECT: &str = "enc_direct";

    // Phase 5 membership
    pub const MEMBERSHIP: &str = "membership";

    pub const ALL: &[&str] = &[
        PROFILE, ORG, ROOM, MESSAGE, REACTION, DM_THREAD,
        KEY_BUNDLE, ENC_CTRL, ENC_DIRECT, MEMBERSHIP,
    ];
}

// ─── Payload types ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfileOp {
    pub op_type: String, // "create_profile" | "update_profile"
    pub username: String,
    pub avatar_blob_id: Option<String>,
    pub bio: Option<String>,
    pub available_for: Vec<String>,
    #[serde(default)]
    pub is_public: bool,
    #[serde(default)]
    pub pre_key_bundle: Option<Vec<u8>>, // CBOR-encoded LongTermKeyBundle
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrgOp {
    pub op_type: String, // "create_org" | "update_org"
    pub name: String,
    pub type_label: String,
    pub description: Option<String>,
    pub avatar_blob_id: Option<String>,
    pub cover_blob_id: Option<String>,
    pub is_public: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrgUpdateOp {
    pub op_type: String, // "update_org"
    pub org_id: String,
    pub name: Option<String>,
    pub type_label: Option<String>,
    pub description: Option<String>,
    pub avatar_blob_id: Option<String>,
    pub cover_blob_id: Option<String>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoomUpdateOp {
    pub op_type: String, // "update_room"
    pub room_id: String,
    pub org_id: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoomOp {
    pub op_type: String, // "create_room" | "update_room" | "delete_room" | "archive_room"
    pub org_id: String,  // hex of the org's root operation hash
    pub name: String,
    pub enc_key_epoch: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoomDeleteOp {
    pub op_type: String, // "delete_room" | "archive_room"
    pub room_id: String, // hex of the room's operation hash
    pub org_id: String,  // hex of the org's root operation hash
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MessageOp {
    pub op_type: String,          // "send" | "edit" | "delete"
    pub room_id: Option<String>,
    pub dm_thread_id: Option<String>,
    pub content_type: String,     // "text" | "audio" | "image" | "gif" | "video" | "embed"
    pub text_content: Option<String>,
    pub blob_id: Option<String>,
    pub embed_url: Option<String>,
    pub mentions: Vec<String>,    // hex public keys
    pub reply_to: Option<String>, // hex op hash
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReactionOp {
    pub op_type: String, // "add_reaction" | "remove_reaction"
    pub message_id: String,
    pub emoji: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DmThreadOp {
    pub op_type: String, // "create_thread"
    pub recipient_key: String, // hex public key
}

// Phase 4 encryption op payloads
#[derive(Debug, Serialize, Deserialize)]
pub struct KeyBundleOp {
    pub bundle_type: String,   // "long_term" | "one_time"
    pub bundle_data: Vec<u8>,  // CBOR-encoded LongTermKeyBundle or OneTimeKeyBundle
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EncCtrlOp {
    pub group_id:  String,   // room_id or thread_id
    pub ctrl_data: Vec<u8>,  // CBOR-encoded ControlMessage
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EncDirectOp {
    pub group_id:      String,   // room_id or thread_id
    pub recipient_key: String,   // hex public key of the addressee
    pub direct_data:   Vec<u8>,  // CBOR-encoded DirectMessage (encrypted toward recipient)
}

// Phase 5 membership op payloads
#[derive(Debug, Serialize, Deserialize)]
pub struct MembershipOp {
    pub op_type: String,      // "add_member" | "remove_member" | "change_permission"
    pub org_id: String,       // organization ID
    pub member_key: String,   // hex public key of the member
    pub access_level: Option<String>, // "pull" | "read" | "write" | "manage" (for add/change)
}

// ─── Gossip wire format ───────────────────────────────────────────────────────

/// CBOR envelope carried by every gossip message (plain or inside a sealed-sender
/// envelope for DM messages).  Includes the log_id so the receiver can store the
/// op without having to infer it from the body.
#[derive(Debug, Serialize, Deserialize)]
pub struct GossipEnvelope {
    pub log_id: String,
    pub header_bytes: Vec<u8>,
    pub body_bytes: Vec<u8>,
}

// ─── CBOR helpers ────────────────────────────────────────────────────────────

pub fn encode_cbor<T: Serialize>(value: &T) -> Result<Vec<u8>, OpsError> {
    let mut buf = Vec::new();
    into_writer(value, &mut buf).map_err(|e| OpsError::CborEncode(e.to_string()))?;
    Ok(buf)
}

pub fn decode_cbor<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, OpsError> {
    from_reader(bytes).map_err(|e| OpsError::CborDecode(e.to_string()))
}

// ─── Op builder ──────────────────────────────────────────────────────────────

/// Build, sign, and insert a new operation into the p2panda store.
///
/// Returns `(op_hash, gossip_bytes)` where `gossip_bytes` is a CBOR-encoded
/// [`GossipEnvelope`] ready to pass to `network::gossip_plain` or
/// `network::gossip_dm_sealed`.  The caller decides how and where to gossip;
/// this function does NOT fire any network traffic.
pub async fn sign_and_store_op(
    store: &mut DeltaStore,
    private_key: &PrivateKey,
    log_id: &str,
    body_bytes: Vec<u8>,
) -> Result<(Hash, Vec<u8>), OpsError> {
    let public_key = private_key.public_key();
    let log_id_str = log_id.to_string();

    // Look up the latest operation in this log to get seq_num + backlink.
    let latest = store
        .latest_operation(&public_key, &log_id_str)
        .await
        .map_err(|e| OpsError::Store(e.to_string()))?;

    let (seq_num, backlink) = match latest {
        Some((prev_header, _)) => (prev_header.seq_num + 1, Some(prev_header.hash())),
        None => (0, None),
    };

    let body = Body::new(&body_bytes);

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| OpsError::SystemTime)?
        .as_micros() as u64;

    let mut header: Header<()> = Header {
        version: 1,
        public_key,
        signature: None,
        payload_size: body.size(),
        payload_hash: Some(body.hash()),
        timestamp,
        seq_num,
        backlink,
        previous: vec![],
        extensions: (),
    };

    header.sign(private_key);

    let op_hash = header.hash();
    let header_bytes = header.to_bytes();

    store
        .insert_operation(op_hash, &header, Some(&body), &header_bytes, &log_id_str)
        .await
        .map_err(|e| OpsError::Store(e.to_string()))?;

    // Build the gossip envelope the caller can use for real-time delivery.
    let gossip_bytes = encode_cbor(&GossipEnvelope {
        log_id: log_id_str,
        header_bytes,
        body_bytes,
    })?;

    Ok((op_hash, gossip_bytes))
}

/// Convenience: encode payload to CBOR and store.
///
/// Returns `(op_hash, gossip_bytes)` — same contract as [`sign_and_store_op`].
pub async fn publish<T: Serialize>(
    store: &mut DeltaStore,
    private_key: &PrivateKey,
    log_id: &str,
    payload: &T,
) -> Result<(Hash, Vec<u8>), OpsError> {
    let body_bytes = encode_cbor(payload)?;
    sign_and_store_op(store, private_key, log_id, body_bytes).await
}

// ─── Tests for Phase 4 encryption ops ───────────────────────────────────────
#[cfg(test)]
mod enc_ops_tests {
    use super::*;

    #[test]
    fn key_bundle_op_cbor_roundtrip() {
        let op = KeyBundleOp { bundle_type: "long_term".into(), bundle_data: vec![1, 2, 3] };
        let bytes = encode_cbor(&op).unwrap();
        let decoded: KeyBundleOp = decode_cbor(&bytes).unwrap();
        assert_eq!(decoded.bundle_type, "long_term");
        assert_eq!(decoded.bundle_data, vec![1, 2, 3]);
    }

    #[test]
    fn enc_ctrl_op_cbor_roundtrip() {
        let op = EncCtrlOp { group_id: "abc".into(), ctrl_data: vec![9, 8] };
        let bytes = encode_cbor(&op).unwrap();
        let decoded: EncCtrlOp = decode_cbor(&bytes).unwrap();
        assert_eq!(decoded.group_id, "abc");
        assert_eq!(decoded.ctrl_data, vec![9, 8]);
    }

    #[test]
    fn enc_direct_op_cbor_roundtrip() {
        let op = EncDirectOp {
            group_id: "room1".into(),
            recipient_key: "deadbeef".into(),
            direct_data: vec![5, 6, 7],
        };
        let bytes = encode_cbor(&op).unwrap();
        let decoded: EncDirectOp = decode_cbor(&bytes).unwrap();
        assert_eq!(decoded.recipient_key, "deadbeef");
    }
}

uniffi::include_scaffolding!("delta_core");

pub mod auth;
pub mod blobs;
pub mod crypto;
pub mod db;
pub mod encryption;
pub mod keys;
pub mod network;
pub mod ops;
pub mod pkarr_publish;
pub mod projector;
pub mod sealed_sender;
pub mod store;
pub mod onion;
pub mod sync;

// ── Phase 1 re-exports (UniFFI uses these) ────────────────────────────────────
pub use keys::{generate_keypair, import_from_mnemonic, KeyError, KeyPair};

// ── Phase 7 re-exports ────────────────────────────────────────────────────────
pub use blobs::{upload_blob, get_blob, BlobError};

// ── Onion routing ─────────────────────────────────────────────────────────────

pub use onion::OnionError;

/// FFI-friendly hop descriptor (uses hex-encoded pubkey for UDL compatibility).
pub struct OnionHopFfi {
    pub pubkey_hex: String,
    pub next_url: String,
}

/// FFI result from peeling one onion layer.
pub struct OnionPeeled {
    pub peel_type: String,
    pub next_hop_url: Option<String>,
    pub inner_packet: Option<Vec<u8>>,
    pub topic_id: Option<Vec<u8>>,
    pub op: Option<Vec<u8>>,
}

pub fn build_onion_packet(
    hops: Vec<OnionHopFfi>,
    topic_id: Vec<u8>,
    op: Vec<u8>,
) -> Result<Vec<u8>, OnionError> {
    if topic_id.len() != 32 {
        return Err(OnionError::InvalidKey(
            "topic_id must be 32 bytes".to_string(),
        ));
    }
    let mut tid = [0u8; 32];
    tid.copy_from_slice(&topic_id);

    let onion_hops: Result<Vec<onion::OnionHop>, OnionError> = hops
        .into_iter()
        .map(|h| {
            let pk_bytes = hex::decode(&h.pubkey_hex)
                .map_err(|e| OnionError::InvalidKey(e.to_string()))?;
            if pk_bytes.len() != 32 {
                return Err(OnionError::InvalidKey(
                    "pubkey must be exactly 32 bytes".to_string(),
                ));
            }
            let mut pk = [0u8; 32];
            pk.copy_from_slice(&pk_bytes);
            Ok(onion::OnionHop { pubkey_bytes: pk, next_url: h.next_url })
        })
        .collect();

    onion::build_onion_packet(&onion_hops?, &tid, &op)
}

pub fn peel_onion_layer(
    packet: Vec<u8>,
    recipient_seed_hex: String,
) -> Result<OnionPeeled, OnionError> {
    let seed_bytes = hex::decode(&recipient_seed_hex)
        .map_err(|e| OnionError::InvalidKey(e.to_string()))?;
    if seed_bytes.len() != 32 {
        return Err(OnionError::InvalidKey("seed must be exactly 32 bytes".to_string()));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&seed_bytes);

    match onion::decrypt_layer(&packet, &seed)? {
        onion::OnionPayload::Forward { next_hop_url, inner_packet } => Ok(OnionPeeled {
            peel_type: "forward".to_string(),
            next_hop_url: Some(next_hop_url),
            inner_packet: Some(inner_packet),
            topic_id: None,
            op: None,
        }),
        onion::OnionPayload::Deliver { topic_id, op } => Ok(OnionPeeled {
            peel_type: "deliver".to_string(),
            next_hop_url: None,
            inner_packet: None,
            topic_id: Some(topic_id.to_vec()),
            op: Some(op),
        }),
    }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SyncFfiError {
    #[error("{0}")]
    Error(String),
}

pub fn ingest_op_ffi(topic_hex: String, seq: i64, op_bytes: Vec<u8>) -> Result<(), SyncFfiError> {
    store::block_on(async move {
        sync::ingest_op(&topic_hex, seq, &op_bytes)
            .await
            .map_err(|e| SyncFfiError::Error(e.0))
    })
}

pub fn get_topic_seq_ffi(topic_hex: String) -> Result<i64, SyncFfiError> {
    store::block_on(async move {
        sync::get_topic_seq(&topic_hex)
            .await
            .map_err(|e| SyncFfiError::Error(e.0))
    })
}

// ── Phase 2 types ─────────────────────────────────────────────────────────────

use std::time::{SystemTime, UNIX_EPOCH};

use p2panda_encryption::key_manager::KeyManager;
use p2panda_encryption::traits::PreKeyManager;
use regex::Regex;

use db::{DmThreadRow, MessageRow, OrgRow, ProfileRow, RoomRow};
use sqlx::Row;

/// Regex pattern for valid sluggified channel names:
/// - lowercase letters, numbers, hyphens, and underscores only
/// - must start with a letter or number
/// - must end with a letter or number
/// - no consecutive hyphens or underscores
/// - minimum 1 character, maximum 50 characters
const CHANNEL_NAME_REGEX: &str = r"^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$";
const MAX_CHANNEL_NAME_LENGTH: usize = 50;

/// Validate that a channel name is properly sluggified.
fn validate_channel_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty() {
        return Err(CoreError::InvalidInput(
            "channel name cannot be empty".into(),
        ));
    }

    if name.len() > MAX_CHANNEL_NAME_LENGTH {
        return Err(CoreError::InvalidInput(format!(
            "channel name too long (max {} characters)",
            MAX_CHANNEL_NAME_LENGTH
        )));
    }

    let re = Regex::new(CHANNEL_NAME_REGEX).unwrap();
    if !re.is_match(name) {
        return Err(CoreError::InvalidInput(
            "channel name must be sluggified: lowercase letters, numbers, hyphens, and underscores only; must start and end with letter or number; no consecutive hyphens".into(),
        ));
    }

    // Check for consecutive hyphens or underscores
    if name.contains("--") || name.contains("__") {
        return Err(CoreError::InvalidInput(
            "channel name cannot contain consecutive hyphens or underscores".into(),
        ));
    }

    Ok(())
}

/// Errors surfaced through UniFFI to React Native.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("Core not initialised — call init_core() first")]
    NotInitialised,
    #[error("Store error: {0}")]
    StoreError(String),
    #[error("Database error: {0}")]
    DbError(String),
    #[error("Op error: {0}")]
    OpsError(String),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

impl From<store::StoreError> for CoreError {
    fn from(e: store::StoreError) -> Self {
        CoreError::StoreError(e.to_string())
    }
}
impl From<db::DbError> for CoreError {
    fn from(e: db::DbError) -> Self {
        CoreError::DbError(e.to_string())
    }
}
impl From<ops::OpsError> for CoreError {
    fn from(e: ops::OpsError) -> Self {
        CoreError::OpsError(e.to_string())
    }
}

// ── Phase 3 types ─────────────────────────────────────────────────────────────

pub struct BootstrapNode {
    pub node_id_hex: String,
    pub relay_url: String,
}

pub enum ConnectionStatus {
    Online,
    Connecting,
    Offline,
}

// UniFFI dictionary types — plain data, no Rust types exposed.

pub struct Profile {
    pub public_key: String,
    pub username: String,
    pub avatar_blob_id: Option<String>,
    pub bio: Option<String>,
    pub available_for: Vec<String>,
    pub is_public: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct OrgSummary {
    pub org_id: String,
    pub name: String,
    pub type_label: String,
    pub description: Option<String>,
    pub avatar_blob_id: Option<String>,
    pub cover_blob_id: Option<String>,
    pub is_public: bool,
    pub creator_key: String,
    pub created_at: i64,
}

pub struct Room {
    pub room_id: String,
    pub org_id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: i64,
    pub enc_key_epoch: u64,
    pub is_archived: bool,
    pub archived_at: Option<i64>,
}

pub struct Message {
    pub message_id: String,
    pub room_id: Option<String>,
    pub dm_thread_id: Option<String>,
    pub author_key: String,
    pub content_type: String,
    pub text_content: Option<String>,
    pub blob_id: Option<String>,
    pub embed_url: Option<String>,
    pub mentions: Vec<String>,
    pub reply_to: Option<String>,
    pub timestamp: i64,
    pub edited_at: Option<i64>,
    pub is_deleted: bool,
}

pub struct DmThread {
    pub thread_id: String,
    pub initiator_key: String,
    pub recipient_key: String,
    pub created_at: i64,
    pub last_message_at: Option<i64>,
}

// ── Conversions from db rows ──────────────────────────────────────────────────

fn profile_from_row(row: ProfileRow) -> Profile {
    Profile {
        public_key: row.public_key,
        username: row.username,
        avatar_blob_id: row.avatar_blob_id,
        bio: row.bio,
        available_for: serde_json::from_str(&row.available_for).unwrap_or_default(),
        is_public: row.is_public.unwrap_or(0) != 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn org_from_row(row: OrgRow) -> OrgSummary {
    OrgSummary {
        org_id: row.org_id,
        name: row.name,
        type_label: row.type_label,
        description: row.description,
        avatar_blob_id: row.avatar_blob_id,
        cover_blob_id: row.cover_blob_id,
        is_public: row.is_public != 0,
        creator_key: row.creator_key,
        created_at: row.created_at,
    }
}

fn room_from_row(row: RoomRow) -> Room {
    Room {
        room_id: row.room_id,
        org_id: row.org_id,
        name: row.name,
        created_by: row.created_by,
        created_at: row.created_at,
        enc_key_epoch: row.enc_key_epoch,
        is_archived: row.is_archived,
        archived_at: row.archived_at,
    }
}

fn message_from_row(row: MessageRow) -> Message {
    Message {
        message_id: row.message_id,
        room_id: row.room_id,
        dm_thread_id: row.dm_thread_id,
        author_key: row.author_key,
        content_type: row.content_type,
        text_content: row.text_content,
        blob_id: row.blob_id,
        embed_url: row.embed_url,
        mentions: row.mentions,
        reply_to: row.reply_to,
        timestamp: row.timestamp,
        edited_at: row.edited_at,
        is_deleted: row.is_deleted,
    }
}

fn dm_from_row(row: DmThreadRow) -> DmThread {
    DmThread {
        thread_id: row.thread_id,
        initiator_key: row.initiator_key,
        recipient_key: row.recipient_key,
        created_at: row.created_at,
        last_message_at: row.last_message_at,
    }
}

fn now_micros() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64
}

// ── UniFFI-exported async functions ───────────────────────────────────────────

/// Must be called once from React Native after biometric unlock.
pub fn init_core(
    private_key_hex: String,
    db_dir: String,
    bootstrap_nodes: Vec<BootstrapNode>,
) -> Result<(), CoreError> {
    store::block_on(async move {
        store::bootstrap(&private_key_hex, &db_dir, bootstrap_nodes)
            .await
            .map_err(CoreError::from)
    })
}

// ── Profile ───────────────────────────────────────────────────────────────────

pub fn create_or_update_profile(
    username: String,
    bio: Option<String>,
    available_for: Vec<String>,
    is_public: bool,
) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let pre_key_bundle: Option<Vec<u8>> = encryption::get_encryption().and_then(|enc| {
            let km = enc.key_manager.try_lock().ok()?;
            let bundle = KeyManager::prekey_bundle(&km).ok()?;
            let mut buf = Vec::new();
            ciborium::into_writer(&bundle, &mut buf).ok()?;
            Some(buf)
        });

        {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::PROFILE,
                &ops::ProfileOp {
                    op_type: "create_profile".into(),
                    username: username.clone(),
                    avatar_blob_id: None,
                    bio: bio.clone(),
                    available_for: available_for.clone(),
                    is_public,
                    pre_key_bundle,
                },
            )
            .await?;
        }

        let now = now_micros();
        let existing = db::get_profile(pool, &core.public_key_hex).await?;
        let created_at = existing.as_ref().map(|p| p.created_at).unwrap_or(now);
        let was_public = existing.as_ref().and_then(|p| p.is_public).unwrap_or(0) != 0;
        
        db::upsert_profile(
            pool,
            &ProfileRow {
                public_key: core.public_key_hex.clone(),
                username: username.clone(),
                avatar_blob_id: None,
                bio: bio.clone(),
                available_for: serde_json::to_string(&available_for).unwrap_or_default(),
                is_public: Some(if is_public { 1 } else { 0 }),
                created_at,
                updated_at: now,
            },
        )
        .await
        .map_err(CoreError::from)?;
        
        // Handle pkarr publishing
        let private_key_hex = core.private_key.to_hex();
        if is_public {
            // Publish profile to DHT
            let _ = pkarr_publish::publish_profile(
                &private_key_hex,
                &username,
                bio.as_deref(),
                None, // avatar_blob_id
            ).await;
        } else if was_public && !is_public {
            // Was public, now private - publish tombstone
            let _ = pkarr_publish::publish_tombstone(&private_key_hex).await;
        }
        
        Ok(())
    })
}

pub fn get_my_profile() -> Option<Profile> {
    store::block_on(async move {
        let core = store::get_core()?;
        db::get_profile(&core.read_pool, &core.public_key_hex)
            .await
            .ok()
            .flatten()
            .map(profile_from_row)
    })
}

pub fn get_profile(public_key: String) -> Option<Profile> {
    store::block_on(async move {
        let core = store::get_core()?;
        db::get_profile(&core.read_pool, &public_key)
            .await
            .ok()
            .flatten()
            .map(profile_from_row)
    })
}

// ── Organizations ─────────────────────────────────────────────────────────────

pub fn create_org(
    name: String,
    type_label: String,
    description: Option<String>,
    is_public: bool,
) -> Result<String, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let now = now_micros();

        // Acquire the lock once for both publishes to avoid contention with
        // the projector, which also holds op_store for its entire tick cycle.
        let (org_id, room_id) = {
            let mut op_store = core.op_store.lock().await;
            let org_hash = ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::ORG,
                &ops::OrgOp {
                    op_type: "create_org".into(),
                    name: name.clone(),
                    type_label: type_label.clone(),
                    description: description.clone(),
                    avatar_blob_id: None,
                    cover_blob_id: None,
                    is_public,
                },
            )
            .await?.0;
            let room_hash = ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::ROOM,
                &ops::RoomOp {
                    op_type: "create_room".into(),
                    org_id: org_hash.to_hex(),
                    name: "general".into(),
                    enc_key_epoch: 0,
                },
            )
            .await?.0;
            (org_hash.to_hex(), room_hash.to_hex())
        };

        db::insert_org(
            pool,
            &OrgRow {
                org_id: org_id.clone(),
                name: name.clone(),
                type_label: type_label.clone(),
                description: description.clone(),
                avatar_blob_id: None,
                cover_blob_id: None,
                is_public: is_public as i64,
                creator_key: core.public_key_hex.clone(),
                created_at: now,
            },
        )
        .await?;

        db::upsert_membership(pool, &org_id, &core.public_key_hex, "manage", now).await?;

        db::insert_room(
            pool,
            &RoomRow {
                room_id: room_id.clone(),
                org_id: org_id.clone(),
                name: "general".into(),
                created_by: core.public_key_hex.clone(),
                created_at: now,
                enc_key_epoch: 0,
                is_archived: false,
                archived_at: None,
            },
        )
        .await?;
        let _ = room_id;

        if is_public {
            let announce = network::DiscoveryAnnounce {
                org_id: org_id.clone(),
                name: name.clone(),
                type_label: type_label.clone(),
                description: description.clone(),
                creator_key: core.public_key_hex.clone(),
                created_at: now,
            };
            if let Ok(bytes) = ops::encode_cbor(&announce) {
                let discovery_topic = network::topic_id_for_discovery(&name);
                tokio::spawn(async move {
                    network::gossip_on_topic(discovery_topic, bytes).await;
                });
            }
            let _ = network::subscribe_org_meta(&org_id).await;
        }

        Ok(org_id)
    })
}

pub fn list_my_orgs() -> Vec<OrgSummary> {
    store::block_on(async move {
        let core = match store::get_core() {
            Some(c) => c,
            None => return vec![],
        };
        db::list_orgs_for_member(&core.read_pool, &core.public_key_hex)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(org_from_row)
            .collect()
    })
}

// ── Rooms ─────────────────────────────────────────────────────────────────────

pub fn create_room(org_id: String, name: String) -> Result<String, CoreError> {
    // Validate channel name is sluggified before proceeding
    validate_channel_name(&name)?;

    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let op_hash = {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::ROOM,
                &ops::RoomOp {
                    op_type: "create_room".into(),
                    org_id: org_id.clone(),
                    name: name.clone(),
                    enc_key_epoch: 0,
                },
            )
            .await?.0
        };

        let room_id = op_hash.to_hex();
        let now = now_micros();

        db::insert_room(
            pool,
            &RoomRow {
                room_id: room_id.clone(),
                org_id,
                name,
                created_by: core.public_key_hex.clone(),
                created_at: now,
                enc_key_epoch: 0,
                is_archived: false,
                archived_at: None,
            },
        )
        .await?;

        Ok(room_id)
    })
}

/// Delete a room. Requires Manage-level permission.
pub fn delete_room(org_id: String, room_id: String) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await
            .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(CoreError::InvalidInput("only Manage-level members can delete rooms".into()));
        }

        // Verify room exists and belongs to this org
        let room = db::get_room(pool, &room_id).await?
            .ok_or_else(|| CoreError::InvalidInput("room not found".into()))?;
        
        if room.org_id != org_id {
            return Err(CoreError::InvalidInput("room does not belong to this organization".into()));
        }

        // Publish delete operation
        let delete_op = ops::RoomDeleteOp {
            op_type: "delete_room".into(),
            room_id: room_id.clone(),
            org_id: org_id.clone(),
        };

        let payload = ops::encode_cbor(&delete_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        {
            let mut store_guard = core.op_store.lock().await;
            ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::ROOM,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
        }

        // Delete from database
        db::delete_room(pool, &room_id).await?;

        Ok(())
    })
}

/// Archive a room. Requires Manage-level permission.
pub fn archive_room(org_id: String, room_id: String) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await
            .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(CoreError::InvalidInput("only Manage-level members can archive rooms".into()));
        }

        // Verify room exists and belongs to this org
        let room = db::get_room(pool, &room_id).await?
            .ok_or_else(|| CoreError::InvalidInput("room not found".into()))?;
        
        if room.org_id != org_id {
            return Err(CoreError::InvalidInput("room does not belong to this organization".into()));
        }

        let now = now_micros();

        // Publish archive operation
        let archive_op = ops::RoomDeleteOp {
            op_type: "archive_room".into(),
            room_id: room_id.clone(),
            org_id: org_id.clone(),
        };

        let payload = ops::encode_cbor(&archive_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        {
            let mut store_guard = core.op_store.lock().await;
            ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::ROOM,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
        }

        // Archive in database
        db::archive_room(pool, &room_id, now).await?;

        Ok(())
    })
}

/// Unarchive a room. Requires Manage-level permission.
pub fn unarchive_room(org_id: String, room_id: String) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await
            .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(CoreError::InvalidInput("only Manage-level members can unarchive rooms".into()));
        }

        // Verify room exists and belongs to this org
        let room = db::get_room(pool, &room_id).await?
            .ok_or_else(|| CoreError::InvalidInput("room not found".into()))?;
        
        if room.org_id != org_id {
            return Err(CoreError::InvalidInput("room does not belong to this organization".into()));
        }

        // Unarchive in database
        db::unarchive_room(pool, &room_id).await?;

        Ok(())
    })
}

/// Update an organization. Requires Manage-level permission.
pub fn update_org(
    org_id: String,
    name: Option<String>,
    type_label: Option<String>,
    description: Option<String>,
    avatar_blob_id: Option<String>,
    cover_blob_id: Option<String>,
    is_public: Option<bool>,
) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await
            .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(CoreError::InvalidInput("only Manage-level members can update organizations".into()));
        }

        // Validate name if provided
        if let Some(ref n) = name {
            if n.len() > 100 {
                return Err(CoreError::InvalidInput("org name too long (max 100 characters)".into()));
            }
        }

        // Publish update operation
        let update_op = ops::OrgUpdateOp {
            op_type: "update_org".into(),
            org_id: org_id.clone(),
            name: name.clone(),
            type_label: type_label.clone(),
            description: description.clone(),
            avatar_blob_id: avatar_blob_id.clone(),
            cover_blob_id: cover_blob_id.clone(),
            is_public,
        };

        let payload = ops::encode_cbor(&update_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        {
            let mut store_guard = core.op_store.lock().await;
            ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::ORG,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
        }

        // Update in database
        db::update_org(
            pool,
            &org_id,
            name.as_deref(),
            type_label.as_deref(),
            description.as_deref(),
            avatar_blob_id.as_deref(),
            cover_blob_id.as_deref(),
            is_public,
        ).await?;

        Ok(())
    })
}

/// Update a room. Requires Manage-level permission.
pub fn update_room(
    org_id: String,
    room_id: String,
    name: Option<String>,
) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await
            .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(CoreError::InvalidInput("only Manage-level members can update rooms".into()));
        }

        // Verify room exists and belongs to this org
        let room = db::get_room(pool, &room_id).await?
            .ok_or_else(|| CoreError::InvalidInput("room not found".into()))?;
        
        if room.org_id != org_id {
            return Err(CoreError::InvalidInput("room does not belong to this organization".into()));
        }

        // Validate name if provided
        if let Some(ref n) = name {
            validate_channel_name(n)?;
        }

        // Publish update operation
        let update_op = ops::RoomUpdateOp {
            op_type: "update_room".into(),
            room_id: room_id.clone(),
            org_id: org_id.clone(),
            name: name.clone(),
        };

        let payload = ops::encode_cbor(&update_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        {
            let mut store_guard = core.op_store.lock().await;
            ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::ROOM,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
        }

        // Update in database
        db::update_room(pool, &room_id, name.as_deref()).await?;

        Ok(())
    })
}

pub fn list_rooms(org_id: String, include_archived: bool) -> Vec<Room> {
    store::block_on(async move {
        let core = match store::get_core() {
            Some(c) => c,
            None => return vec![],
        };
        db::list_rooms(&core.read_pool, &org_id, include_archived)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(room_from_row)
            .collect()
    })
}

// ── Messages ──────────────────────────────────────────────────────────────────

pub fn send_message(
    room_id: Option<String>,
    dm_thread_id: Option<String>,
    content_type: String,
    text_content: Option<String>,
    blob_id: Option<String>,
    embed_url: Option<String>,
    mentions: Vec<String>,
    reply_to: Option<String>,
) -> Result<String, CoreError> {
    if room_id.is_none() && dm_thread_id.is_none() {
        return Err(CoreError::InvalidInput("room_id or dm_thread_id required".into()));
    }
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let (op_hash, gossip_bytes) = {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::MESSAGE,
                &ops::MessageOp {
                    op_type: "send".into(),
                    room_id: room_id.clone(),
                    dm_thread_id: dm_thread_id.clone(),
                    content_type: content_type.clone(),
                    text_content: text_content.clone(),
                    blob_id: blob_id.clone(),
                    embed_url: embed_url.clone(),
                    mentions: mentions.clone(),
                    reply_to: reply_to.clone(),
                },
            )
            .await?
        };

        let message_id = op_hash.to_hex();
        let now = now_micros();

        db::insert_message(
            pool,
            &MessageRow {
                message_id: message_id.clone(),
                room_id: room_id.clone(),
                dm_thread_id: dm_thread_id.clone(),
                author_key: core.public_key_hex.clone(),
                content_type,
                text_content,
                blob_id,
                embed_url,
                mentions,
                reply_to,
                timestamp: now,
                edited_at: None,
                is_deleted: false,
            },
        )
        .await?;

        // Real-time gossip delivery.
        if let Some(ref tid) = dm_thread_id {
            // Sealed gossip on the DM topic so only the recipient can read it.
            if let Ok(Some(thread)) = db::get_dm_thread(pool, tid).await {
                let recipient_key = if thread.initiator_key == core.public_key_hex {
                    thread.recipient_key
                } else {
                    thread.initiator_key
                };
                if let Ok(rk_bytes) = hex::decode(&recipient_key) {
                    if let Ok(rk_arr) = <[u8; 32]>::try_from(rk_bytes.as_slice()) {
                        let sender_pk_bytes = *core.private_key.public_key().as_bytes();
                        let sender_hex = core.public_key_hex.clone();
                        let gb = gossip_bytes;
                        tokio::spawn(async move {
                            let _ = network::gossip_dm_sealed(
                                &gb, &sender_hex, &sender_pk_bytes, &recipient_key, &rk_arr,
                            ).await;
                        });
                    }
                }
            }
        } else if let Some(ref rid) = room_id {
            let topic = network::topic_id_for_room(rid);
            tokio::spawn(async move {
                network::gossip_plain(topic, gossip_bytes).await;
            });
        }

        Ok(message_id)
    })
}

pub fn list_messages(
    room_id: Option<String>,
    dm_thread_id: Option<String>,
    limit: u32,
    before_timestamp: Option<i64>,
) -> Vec<Message> {
    store::block_on(async move {
        let core = match store::get_core() {
            Some(c) => c,
            None => return vec![],
        };
        db::list_messages(
            &core.read_pool,
            room_id.as_deref(),
            dm_thread_id.as_deref(),
            limit,
            before_timestamp,
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(message_from_row)
        .collect()
    })
}

// ── DM Threads ────────────────────────────────────────────────────────────────

pub fn create_dm_thread(recipient_key: String) -> Result<String, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let (op_hash, gossip_bytes) = {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::DM_THREAD,
                &ops::DmThreadOp {
                    op_type: "create_thread".into(),
                    recipient_key: recipient_key.clone(),
                },
            )
            .await?
        };

        let thread_id = op_hash.to_hex();
        let now = now_micros();

        db::insert_dm_thread(
            pool,
            &DmThreadRow {
                thread_id: thread_id.clone(),
                initiator_key: core.public_key_hex.clone(),
                recipient_key: recipient_key.clone(),
                created_at: now,
                last_message_at: None,
            },
        )
        .await?;

        // Sealed-gossip the thread-creation op so the recipient knows immediately.
        if let Ok(rk_bytes) = hex::decode(&recipient_key) {
            if let Ok(rk_arr) = <[u8; 32]>::try_from(rk_bytes.as_slice()) {
                let sender_pk_bytes = *core.private_key.public_key().as_bytes();
                let sender_hex = core.public_key_hex.clone();
                let gb = gossip_bytes;
                tokio::spawn(async move {
                    let _ = network::gossip_dm_sealed(
                        &gb, &sender_hex, &sender_pk_bytes, &recipient_key, &rk_arr,
                    ).await;
                });
            }
        }

        Ok(thread_id)
    })
}

pub fn list_dm_threads() -> Vec<DmThread> {
    store::block_on(async move {
        let core = match store::get_core() {
            Some(c) => c,
            None => return vec![],
        };
        db::list_dm_threads(&core.read_pool, &core.public_key_hex)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(dm_from_row)
            .collect()
    })
}

// ── Phase 3: Network ──────────────────────────────────────────────────────────

pub fn get_connection_status() -> ConnectionStatus {
    store::block_on(async move { network::connection_status() })
}

pub fn subscribe_room_topic(room_id: String) -> Result<(), CoreError> {
    store::block_on(async move {
        network::subscribe_room(&room_id).await.map_err(|e| CoreError::StoreError(e.to_string()))
    })
}

pub fn subscribe_dm_topic(thread_id: String) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let thread = db::get_dm_thread(&core.read_pool, &thread_id)
            .await
            .map_err(CoreError::from)?
            .ok_or_else(|| CoreError::InvalidInput(format!("thread {} not found", thread_id)))?;
        network::subscribe_dm_thread(&thread.initiator_key, &thread.recipient_key)
            .await
            .map_err(|e| CoreError::StoreError(e.to_string()))
    })
}

pub fn search_public_orgs(query: String) -> Vec<OrgSummary> {
    store::block_on(async move {
        network::search_public_orgs(&query)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(org_from_row)
            .collect()
    })
}

// ── Phase 5 types ─────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Token expired")]
    TokenExpired,
    #[error("Unauthorized: {0}")]
    Unauthorized(String),
    #[error("Core not initialised")]
    NotInitialised,
}

impl From<auth::AuthError> for AuthError {
    fn from(e: auth::AuthError) -> Self {
        match e {
            auth::AuthError::InvalidSignature => AuthError::InvalidSignature,
            auth::AuthError::TokenExpired => AuthError::TokenExpired,
            auth::AuthError::Unauthorized(msg) => AuthError::Unauthorized(msg),
            _ => AuthError::Unauthorized(e.to_string()),
        }
    }
}

pub struct InviteTokenInfo {
    pub org_id: String,
    pub inviter_key: String,
    pub access_level: String,
    pub expiry_timestamp: i64,
}

pub struct MemberInfo {
    pub public_key: String,
    pub access_level: String,
    pub joined_at: i64,
}

// ── Phase 5: Membership & Auth ────────────────────────────────────────────────

/// Generate an invite token for an organization.
/// Returns base64-encoded token string for sharing via QR/NFC.
pub fn generate_invite_token(
    org_id: String,
    access_level: String,
    expiry_timestamp: i64,
) -> Result<String, AuthError> {
    let core = store::get_core().ok_or(AuthError::NotInitialised)?;
    
    let level = auth::AccessLevel::from_str(&access_level)
        .ok_or_else(|| AuthError::Unauthorized("invalid access level".into()))?;

    let token = auth::InviteToken::create(
        org_id,
        core.private_key.public_key(),
        level,
        expiry_timestamp,
        &core.private_key,
    );

    token.to_base64().map_err(AuthError::from)
}

/// Verify an invite token and return its details.
pub fn verify_invite_token(
    token_base64: String,
    current_timestamp: i64,
) -> Result<InviteTokenInfo, AuthError> {
    let token = auth::InviteToken::from_base64(&token_base64)?;
    let (inviter_key, access_level) = token.verify(current_timestamp)?;

    Ok(InviteTokenInfo {
        org_id: token.org_id,
        inviter_key: inviter_key.to_hex(),
        access_level: access_level.as_str().to_string(),
        expiry_timestamp: token.expiry_timestamp,
    })
}

/// Add a member directly to an organization (NFC path).
/// Requires Manage-level permission.
pub fn add_member_direct(
    org_id: String,
    member_public_key: String,
    access_level: String,
) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;

        let level = auth::AccessLevel::from_str(&access_level)
            .ok_or_else(|| AuthError::Unauthorized("invalid access level".into()))?;

        let member_key_bytes = hex::decode(&member_public_key)
            .map_err(|_| AuthError::Unauthorized("invalid public key".into()))?;
        let member_key_array: [u8; 32] = member_key_bytes.as_slice().try_into()
            .map_err(|_| AuthError::Unauthorized("invalid public key length".into()))?;
        let member_key = p2panda_core::PublicKey::from_bytes(&member_key_array)
            .map_err(|_| AuthError::Unauthorized("invalid public key".into()))?;

        let mut state = get_org_membership_state(&org_id).await?;

        let _op_hash = auth::add_member(
            &mut state,
            &core.private_key.public_key(),
            member_key,
            level,
        ).await?;

        let joined_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as i64;

        db::upsert_membership(
            &core.read_pool,
            &org_id,
            &member_public_key,
            level.as_str(),
            joined_at,
        )
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let membership_op = ops::MembershipOp {
            op_type: "add_member".into(),
            org_id: org_id.clone(),
            member_key: member_public_key.clone(),
            access_level: Some(level.as_str().to_string()),
        };

        let payload = ops::encode_cbor(&membership_op)
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let mut store_guard = core.op_store.lock().await;
        ops::sign_and_store_op(
            &mut *store_guard,
            &core.private_key,
            ops::log_ids::MEMBERSHIP,
            payload,
        )
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        network::gossip_on_org(&org_id).await;

        Ok(())
    })
}

/// Remove a member from an organization.
/// Requires Manage-level permission.
pub fn remove_member_from_org(
    org_id: String,
    member_public_key: String,
) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;

        let member_key_bytes = hex::decode(&member_public_key)
            .map_err(|_| AuthError::Unauthorized("invalid public key".into()))?;
        let member_key_array: [u8; 32] = member_key_bytes.as_slice().try_into()
            .map_err(|_| AuthError::Unauthorized("invalid public key length".into()))?;
        let member_key = p2panda_core::PublicKey::from_bytes(&member_key_array)
            .map_err(|_| AuthError::Unauthorized("invalid public key".into()))?;

        let mut state = get_org_membership_state(&org_id).await?;

        let _op_hash = auth::remove_member(
            &mut state,
            &core.private_key.public_key(),
            &member_key,
        ).await?;

        let query = "DELETE FROM memberships WHERE org_id = ? AND member_key = ?";
        sqlx::query(query)
            .bind(&org_id)
            .bind(&member_public_key)
            .execute(&core.read_pool)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let membership_op = ops::MembershipOp {
            op_type: "remove_member".into(),
            org_id: org_id.clone(),
            member_key: member_public_key,
            access_level: None,
        };

        let payload = ops::encode_cbor(&membership_op)
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let mut store_guard = core.op_store.lock().await;
        ops::sign_and_store_op(
            &mut *store_guard,
            &core.private_key,
            ops::log_ids::MEMBERSHIP,
            payload,
        )
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        network::gossip_on_org(&org_id).await;

        Ok(())
    })
}

/// Change a member's access level.
/// Requires Manage-level permission.
pub fn change_member_permission(
    org_id: String,
    member_public_key: String,
    new_access_level: String,
) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;

        let new_level = auth::AccessLevel::from_str(&new_access_level)
            .ok_or_else(|| AuthError::Unauthorized("invalid access level".into()))?;

        let member_key_bytes = hex::decode(&member_public_key)
            .map_err(|_| AuthError::Unauthorized("invalid public key".into()))?;
        let member_key_array: [u8; 32] = member_key_bytes.as_slice().try_into()
            .map_err(|_| AuthError::Unauthorized("invalid public key length".into()))?;
        let member_key = p2panda_core::PublicKey::from_bytes(&member_key_array)
            .map_err(|_| AuthError::Unauthorized("invalid public key".into()))?;

        let mut state = get_org_membership_state(&org_id).await?;

        let _op_hash = auth::change_permission(
            &mut state,
            &core.private_key.public_key(),
            member_key,
            new_level,
        ).await?;

        let joined_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as i64;

        db::upsert_membership(
            &core.read_pool,
            &org_id,
            &member_public_key,
            new_level.as_str(),
            joined_at,
        )
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let membership_op = ops::MembershipOp {
            op_type: "change_permission".into(),
            org_id: org_id.clone(),
            member_key: member_public_key,
            access_level: Some(new_level.as_str().to_string()),
        };

        let payload = ops::encode_cbor(&membership_op)
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let mut store_guard = core.op_store.lock().await;
        ops::sign_and_store_op(
            &mut *store_guard,
            &core.private_key,
            ops::log_ids::MEMBERSHIP,
            payload,
        )
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        network::gossip_on_org(&org_id).await;

        Ok(())
    })
}

/// List all members of an organization.
pub fn list_org_members(org_id: String) -> Vec<MemberInfo> {
    store::block_on(async move {
        let Some(core) = store::get_core() else {
            return vec![];
        };

        let query = "SELECT member_key, access_level, joined_at FROM memberships WHERE org_id = ?";
        let rows = sqlx::query(query)
            .bind(&org_id)
            .fetch_all(&core.read_pool)
            .await
            .unwrap_or_default();

        rows.into_iter()
            .map(|row| MemberInfo {
                public_key: row.get("member_key"),
                access_level: row.get("access_level"),
                joined_at: row.get("joined_at"),
            })
            .collect()
    })
}

// ── Helper: Get org membership state ──────────────────────────────────────────

async fn get_org_membership_state(org_id: &str) -> Result<auth::MembershipState, AuthError> {
    let core = store::get_core().ok_or(AuthError::NotInitialised)?;

    let mut state = auth::MembershipState::new(org_id.to_string());

    // Load members from database
    let query = "SELECT member_key, access_level FROM memberships WHERE org_id = ?";
    let rows = sqlx::query(query)
        .bind(org_id)
        .fetch_all(&core.read_pool)
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

    for row in rows {
        let member_key_hex: String = row.get("member_key");
        let access_level_str: String = row.get("access_level");

        let member_key_bytes = hex::decode(&member_key_hex)
            .map_err(|_| AuthError::Unauthorized("invalid member key in db".into()))?;
        let member_key_array: [u8; 32] = member_key_bytes.as_slice().try_into()
            .map_err(|_| AuthError::Unauthorized("invalid member key length".into()))?;
        let member_key = p2panda_core::PublicKey::from_bytes(&member_key_array)
            .map_err(|_| AuthError::Unauthorized("invalid member key".into()))?;

        if let Some(level) = auth::AccessLevel::from_str(&access_level_str) {
            state.add_member(member_key, level);
        }
    }

    Ok(state)
}

// ── pkarr public profiles ─────────────────────────────────────────────────────

pub fn get_pkarr_url(public_key_hex: String) -> Result<String, CoreError> {
    pkarr_publish::get_pkarr_url(&public_key_hex)
        .map_err(|e| CoreError::InvalidInput(e))
}

pub fn resolve_pkarr(z32_key: String) -> Result<Option<PkarrResolved>, CoreError> {
    store::block_on(async move {
        let record = pkarr_publish::resolve_pkarr(&z32_key).await
            .map_err(|e| CoreError::InvalidInput(e))?;
        
        Ok(record.map(|r| PkarrResolved {
            record_type: r.record_type,
            name: r.name,
            username: r.username,
            description: r.description,
            bio: r.bio,
            avatar_blob_id: r.avatar_blob_id,
            cover_blob_id: r.cover_blob_id,
            public_key: r.public_key,
        }))
    })
}

pub struct PkarrResolved {
    pub record_type: String,
    pub name: Option<String>,
    pub username: Option<String>,
    pub description: Option<String>,
    pub bio: Option<String>,
    pub avatar_blob_id: Option<String>,
    pub cover_blob_id: Option<String>,
    pub public_key: String,
}

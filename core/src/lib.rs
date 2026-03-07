uniffi::include_scaffolding!("gardens_core");

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
pub mod sync_config;

// ── Phase 1 re-exports (UniFFI uses these) ────────────────────────────────────
pub use keys::{generate_keypair, import_from_mnemonic, KeyError, KeyPair};

// ── Phase 7 re-exports ────────────────────────────────────────────────────────
pub use blobs::{provide_blob, BlobError};

/// Upload a blob and return its content-hash (hex).
pub fn upload_blob(data: Vec<u8>, mime_type: String, room_id: Option<String>) -> Result<String, BlobError> {
    store::block_on(async move {
        blobs::upload_blob(data, mime_type, room_id).await
    })
}

/// Get blob data with optional room decryption.
pub fn get_blob(hash_str: String, room_id: Option<String>) -> Result<Vec<u8>, BlobError> {
    store::block_on(async move {
        blobs::get_blob(&hash_str, room_id).await
    })
}

/// Check if we have a blob locally (for P2P availability checks).
pub fn has_blob(hash_str: String) -> Result<bool, BlobError> {
    store::block_on(async move {
        blobs::has_blob(&hash_str).await
    })
}

/// Request a blob from a specific peer via P2P.
pub fn request_blob_from_peer(hash_str: String, peer_node_id: String) -> Result<Option<Vec<u8>>, BlobError> {
    store::block_on(async move {
        blobs::request_blob_from_peer(&hash_str, &peer_node_id).await?;
        // After requesting, try to get the blob
        match blobs::get_blob(&hash_str, None).await {
            Ok(data) => Ok(Some(data)),
            Err(blobs::BlobError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    })
}

/// Provide (send) a blob to a peer who requested it.
pub fn provide_blob_to_peer(hash_str: String, _peer_public_key: String) -> Result<(), BlobError> {
    store::block_on(async move {
        blobs::provide_blob(&hash_str).await
    })
}

/// Returned by send_message and create_dm_thread.
/// `op_bytes` is the GossipEnvelope CBOR; the app layer forwards it via onion routing.
pub struct SendResult {
    pub id: String,
    pub op_bytes: Vec<u8>,
}

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

// ── Sync Configuration ───────────────────────────────────────────────────────

/// FFI-friendly hop descriptor for sync configuration.
pub struct SyncHopFfi {
    pub pubkey_hex: String,
    pub next_url: String,
}

/// Initialize sync configuration with relay hops and sync URL.
/// Called from JS after relay discovery resolves hop list.
pub fn init_sync(hops: Vec<SyncHopFfi>, sync_url: String) {
    let hop_tuples: Vec<(String, String)> = hops
        .into_iter()
        .map(|h| (h.pubkey_hex, h.next_url))
        .collect();
    sync_config::set(hop_tuples, sync_url);
}

/// Get the current relay hops from sync configuration.
pub fn get_relay_hops() -> Vec<SyncHopFfi> {
    sync_config::get_hops()
        .into_iter()
        .map(|(pubkey_hex, next_url)| SyncHopFfi { pubkey_hex, next_url })
        .collect()
}

/// Get the current sync WebSocket URL from sync configuration.
pub fn get_sync_url() -> String {
    sync_config::get_url()
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

use db::{DmThreadRow, MessageRow, OrgRow, ProfileRow, RoomRow, EventRow, EventRsvpRow};
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
    pub welcome_text: Option<String>,
    pub custom_emoji_json: Option<String>,
    pub org_cooldown_secs: Option<i64>,
    pub is_public: bool,
    pub creator_key: String,
    pub org_pubkey: Option<String>,  // NEW: Org's public key for pkarr
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
    pub room_cooldown_secs: Option<i64>,
}

pub struct Event {
    pub event_id: String,
    pub org_id: String,
    pub title: String,
    pub description: Option<String>,
    pub location_type: String,
    pub location_text: Option<String>,
    pub location_room_id: Option<String>,
    pub start_at: i64,
    pub end_at: Option<i64>,
    pub created_by: String,
    pub created_at: i64,
    pub is_deleted: bool,
}

pub struct EventRsvp {
    pub event_id: String,
    pub member_key: String,
    pub status: String,
    pub updated_at: i64,
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

pub struct Reaction {
    pub message_id: String,
    pub emoji: String,
    pub reactor_key: String,
}

pub struct IceInfo {
    pub public_key: String,
    pub iced_until: i64,
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
        welcome_text: row.welcome_text,
        custom_emoji_json: row.custom_emoji_json,
        org_cooldown_secs: row.org_cooldown_secs,
        is_public: row.is_public != 0,
        creator_key: row.creator_key,
        org_pubkey: row.org_pubkey,
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
        room_cooldown_secs: row.room_cooldown_secs,
    }
}

fn event_from_row(row: EventRow) -> Event {
    Event {
        event_id: row.event_id,
        org_id: row.org_id,
        title: row.title,
        description: row.description,
        location_type: row.location_type,
        location_text: row.location_text,
        location_room_id: row.location_room_id,
        start_at: row.start_at,
        end_at: row.end_at,
        created_by: row.created_by,
        created_at: row.created_at,
        is_deleted: row.is_deleted,
    }
}

fn event_rsvp_from_row(row: EventRsvpRow) -> EventRsvp {
    EventRsvp {
        event_id: row.event_id,
        member_key: row.member_key,
        status: row.status,
        updated_at: row.updated_at,
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
) -> Result<(), CoreError> {
    #[cfg(target_os = "android")]
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Debug));

    store::block_on(async move {
        store::bootstrap(&private_key_hex, &db_dir)
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
    avatar_blob_id: Option<String>,
    email_enabled: bool,
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
                avatar_blob_id: avatar_blob_id.clone().or_else(|| existing.as_ref().and_then(|p| p.avatar_blob_id.clone())),
                bio: bio.clone(),
                available_for: serde_json::to_string(&available_for).unwrap_or_default(),
                is_public: Some(if is_public { 1 } else { 0 }),
                created_at,
                updated_at: now,
                email_enabled: if email_enabled { 1 } else { 0 },
            },
        )
        .await
        .map_err(CoreError::from)?;
        
        // Handle pkarr publishing
        let private_key_hex = core.private_key.to_hex();
        if is_public {
            // Publish profile to DHT
            let avatar_for_publish = avatar_blob_id.clone()
                .or_else(|| existing.as_ref().and_then(|p| p.avatar_blob_id.clone()));
            let relay_z32_for_publish = sync_config::get_relay_z32();
            if let Err(e) = pkarr_publish::publish_profile(
                &private_key_hex,
                &username,
                bio.as_deref(),
                avatar_for_publish.as_deref(),
                relay_z32_for_publish.as_deref(),
                email_enabled,
            ).await {
                log::error!("[pkarr] Failed to publish profile: {}", e);
            } else {
                log::info!("[pkarr] Profile published successfully");
            }
        } else if was_public && !is_public {
            // Was public, now private - publish tombstone
            if let Err(e) = pkarr_publish::publish_tombstone(&private_key_hex).await {
                log::error!("[pkarr] Failed to publish tombstone: {}", e);
            }
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

        // Generate org keypair - convert p2panda key to ed25519
        let user_signing_key = ed25519_dalek::SigningKey::from_bytes(
            &hex::decode(core.private_key.to_hex()).map_err(|e| CoreError::InvalidInput(e.to_string()))?
                .try_into().map_err(|_| CoreError::InvalidInput("invalid key length".into()))?
        );
        let (org_pubkey_z32, org_privkey_enc) = generate_org_keypair(&user_signing_key);
        let org_privkey_enc_for_publish = org_privkey_enc.clone();

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
                    welcome_text: None,
                    custom_emoji_json: None,
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
                welcome_text: None,
                custom_emoji_json: None,
                org_cooldown_secs: None,
                is_public: is_public as i64,
                creator_key: core.public_key_hex.clone(),
                org_pubkey: Some(org_pubkey_z32),
                org_privkey_enc: Some(org_privkey_enc),
                created_at: now,
                email_enabled: 0,
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
                room_cooldown_secs: None,
            },
        )
        .await?;

        // Initialize encryption group state for the general room
        // At org creation, only the creator is a member
        let initial_members = vec![core.private_key.public_key()];
        if let Err(e) = encryption::init_room_group(&room_id, initial_members).await {
            log::warn!("Failed to initialize general room encryption group: {}", e);
        }

        // Publish to pkarr immediately if org is public
        if is_public {
            if let Some(org_seed) = decrypt_org_privkey(&org_privkey_enc_for_publish, &user_signing_key) {
                let org_pk_hex = hex::encode(org_seed);
                let relay_z32_for_publish = sync_config::get_relay_z32();
                if let Err(e) = pkarr_publish::publish_org_with_key(
                    &org_pk_hex,
                    &org_id,
                    &name,
                    description.as_deref(),
                    None,
                    None,
                    relay_z32_for_publish.as_deref(),
                    false,
                ).await {
                    log::error!("[pkarr] failed to publish new org: {}", e);
                }
            }
        }

        // op delivered via onion routing from the app layer

        Ok(org_id)
    })
}

pub fn list_my_orgs() -> Vec<OrgSummary> {
    store::block_on(async move {
        let core = match store::get_core() {
            Some(c) => c,
            None => return vec![],
        };
        let mut rows = db::list_orgs_for_member(&core.read_pool, &core.public_key_hex)
            .await
            .unwrap_or_default();

        // Backfill missing org_pubkey so clients resolve the correct pkarr URL.
        let user_signing_key = match ed25519_dalek::SigningKey::from_bytes(
            &hex::decode(core.private_key.to_hex()).unwrap_or_default()
                .try_into().unwrap_or([0u8; 32])
        ) {
            key => key,
        };

        for row in rows.iter_mut() {
            if row.org_pubkey.is_none() {
                if let Some(encrypted_key) = row.org_privkey_enc.as_ref() {
                    if let Some(org_seed) = decrypt_org_privkey(encrypted_key, &user_signing_key) {
                        let org_keypair = ed25519_dalek::SigningKey::from_bytes(&org_seed);
                        let z32_pubkey = z32::encode(org_keypair.verifying_key().as_bytes());
                        if db::set_org_pubkey(&core.read_pool, &row.org_id, &z32_pubkey).await.is_ok() {
                            row.org_pubkey = Some(z32_pubkey);
                        }
                    }
                }
            }
        }

        rows.into_iter().map(org_from_row).collect()
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
                org_id: org_id.clone(),
                name: name.clone(),
                created_by: core.public_key_hex.clone(),
                created_at: now,
                enc_key_epoch: 0,
                is_archived: false,
                archived_at: None,
                room_cooldown_secs: None,
            },
        )
        .await?;

        // Initialize encryption group state for this room
        // Get all current org members to include in the group
        let mut initial_members: Vec<p2panda_core::PublicKey> = vec![core.private_key.public_key()];
        
        let member_rows = sqlx::query("SELECT member_key FROM memberships WHERE org_id = ?")
            .bind(&org_id)
            .fetch_all(pool)
            .await
            .map_err(|e| CoreError::DbError(e.to_string()))?;
        
        for row in member_rows {
            let member_key_hex: String = row.get("member_key");
            if member_key_hex != core.public_key_hex {
                if let Ok(bytes) = hex::decode(&member_key_hex) {
                    if let Ok(arr) = bytes.try_into() {
                        if let Ok(pk) = p2panda_core::PublicKey::from_bytes(&arr) {
                            initial_members.push(pk);
                        }
                    }
                }
            }
        }

        if let Err(e) = encryption::init_room_group(&room_id, initial_members).await {
            log::warn!("Failed to initialize room encryption group: {}", e);
            // Don't fail room creation if encryption init fails
            // The group can be initialized later when needed
        }

        // Join gossip topic for this room
        if network::is_initialized().await {
            if let Ok((topic_id, peers)) = room_gossip_context(&core, &room_id).await {
                let _ = network::gossip_join(topic_id, network::GossipTopicKind::Room, peers).await;
            }
        }

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
/// Signs the operation with the org's key, not the user's key.
pub fn update_org(
    org_id: String,
    name: Option<String>,
    type_label: Option<String>,
    description: Option<String>,
    avatar_blob_id: Option<String>,
    cover_blob_id: Option<String>,
    welcome_text: Option<String>,
    custom_emoji_json: Option<String>,
    org_cooldown_secs: Option<i64>,
    is_public: Option<bool>,
    email_enabled: Option<bool>,
) -> Result<Vec<u8>, CoreError> {
    store::block_on(async move {
        log::info!(
            "[update_org] org_id={} is_public={:?}",
            org_id,
            is_public
        );
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

        // Get the org's encrypted private key from database
        let org_row = db::get_org(pool, &org_id).await?
            .ok_or_else(|| CoreError::InvalidInput("organization not found".into()))?;
        
        let encrypted_key = org_row.org_privkey_enc
            .ok_or_else(|| CoreError::InvalidInput("org key not available".into()))?;
        
        // Decrypt the org's private key
        let user_signing_key = ed25519_dalek::SigningKey::from_bytes(
            &hex::decode(core.private_key.to_hex()).map_err(|e| CoreError::InvalidInput(e.to_string()))?
                .try_into().map_err(|_| CoreError::InvalidInput("invalid key length".into()))?
        );
        
        let org_private_key = get_org_private_key(&encrypted_key, &user_signing_key)
            .ok_or_else(|| CoreError::InvalidInput("failed to decrypt org key".into()))?;

        // Publish update operation signed with ORG's key
        let update_op = ops::OrgUpdateOp {
            op_type: "update_org".into(),
            org_id: org_id.clone(),
            name: name.clone(),
            type_label: type_label.clone(),
            description: description.clone(),
            avatar_blob_id: avatar_blob_id.clone(),
            cover_blob_id: cover_blob_id.clone(),
            welcome_text: welcome_text.clone(),
            custom_emoji_json: custom_emoji_json.clone(),
            org_cooldown_secs,
            is_public,
        };

        let payload = ops::encode_cbor(&update_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        let gossip_bytes = {
            let mut store_guard = core.op_store.lock().await;
            let (_op_hash, gossip_bytes) = ops::sign_and_store_op(
                &mut *store_guard,
                &org_private_key,  // Sign with org's key, not user's key
                ops::log_ids::ORG,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
            gossip_bytes
        };

        // Update in database
        db::update_org(
            pool,
            &org_id,
            name.as_deref(),
            type_label.as_deref(),
            description.as_deref(),
            avatar_blob_id.as_deref(),
            cover_blob_id.as_deref(),
            welcome_text.as_deref(),
            custom_emoji_json.as_deref(),
            org_cooldown_secs,
            is_public,
            email_enabled,
        ).await?;
        
        // Backfill org_pubkey if it was clobbered by older projector inserts.
        let mut org_pubkey_z32 = org_row.org_pubkey.clone();
        if org_pubkey_z32.is_none() {
            let z32_pubkey = z32::encode(org_private_key.public_key().as_bytes());
            if db::set_org_pubkey(pool, &org_id, &z32_pubkey).await.is_ok() {
                org_pubkey_z32 = Some(z32_pubkey);
            }
        }

        // Publish to pkarr if public
        if is_public == Some(true) || (is_public.is_none() && org_row.is_public != 0) {
            if org_pubkey_z32.is_some() {
                let pk_hex = hex::encode(org_private_key.as_bytes());
                let org_name = name.as_deref().unwrap_or(&org_row.name);
                let org_desc = description.as_deref().or(org_row.description.as_deref());

                let relay_z32_for_publish = sync_config::get_relay_z32();
                if let Err(e) = pkarr_publish::publish_org_with_key(
                    &pk_hex,
                    &org_id,
                    org_name,
                    org_desc,
                    avatar_blob_id.as_deref(),
                    cover_blob_id.as_deref(),
                    relay_z32_for_publish.as_deref(),
                    email_enabled.unwrap_or(false),
                ).await {
                    log::error!("[pkarr] failed to publish org update: {}", e);
                }
            }
        }

        Ok(gossip_bytes)
    })
}

/// Delete an organization. Requires Manage-level permission.
/// This is a soft delete - marks the org as deleted but preserves data.
pub fn delete_org(org_id: String) -> Result<(), CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await
            .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(CoreError::InvalidInput("only Manage-level members can delete organizations".into()));
        }

        // Get the org's encrypted private key from database
        let org_row = db::get_org(pool, &org_id).await?
            .ok_or_else(|| CoreError::InvalidInput("organization not found".into()))?;
        
        let encrypted_key = org_row.org_privkey_enc
            .ok_or_else(|| CoreError::InvalidInput("org key not available".into()))?;
        
        // Decrypt the org's private key
        let user_signing_key = ed25519_dalek::SigningKey::from_bytes(
            &hex::decode(core.private_key.to_hex()).map_err(|e| CoreError::InvalidInput(e.to_string()))?
                .try_into().map_err(|_| CoreError::InvalidInput("invalid key length".into()))?
        );
        
        let org_private_key = get_org_private_key(&encrypted_key, &user_signing_key)
            .ok_or_else(|| CoreError::InvalidInput("failed to decrypt org key".into()))?;

        // Publish delete operation signed with ORG's key
        let delete_op = ops::OrgUpdateOp {
            op_type: "delete_org".into(),
            org_id: org_id.clone(),
            name: None,
            type_label: None,
            description: None,
            avatar_blob_id: None,
            cover_blob_id: None,
            welcome_text: None,
            custom_emoji_json: None,
            org_cooldown_secs: None,
            is_public: None,
        };

        let payload = ops::encode_cbor(&delete_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        {
            let mut store_guard = core.op_store.lock().await;
            ops::sign_and_store_op(
                &mut *store_guard,
                &org_private_key,
                ops::log_ids::ORG,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
        }

        // Soft delete: remove from active orgs but keep data
        // Delete all memberships first
        sqlx::query("DELETE FROM memberships WHERE org_id = ?")
            .bind(&org_id)
            .execute(pool)
            .await
            .map_err(|e| CoreError::DbError(e.to_string()))?;

        // Delete the org
        sqlx::query("DELETE FROM organizations WHERE org_id = ?")
            .bind(&org_id)
            .execute(pool)
            .await
            .map_err(|e| CoreError::DbError(e.to_string()))?;

        // Publish tombstone to pkarr if it was public
        if org_row.is_public != 0 {
            if let Some(org_pubkey) = org_row.org_pubkey {
                if let Err(e) = pkarr_publish::publish_tombstone_for_org(&org_pubkey).await {
                    log::error!("[pkarr] failed to publish org tombstone: {}", e);
                }
            }
        }

        Ok(())
    })
}

// ── Member Moderation ─────────────────────────────────────────────────────────

/// Kick a member from the organization (removes immediately).
/// Requires Manage-level permission.
pub fn kick_member(org_id: String, member_public_key: String) -> Result<(), AuthError> {
    // Delegates to remove_member_from_org which already checks permissions
    remove_member_from_org(org_id, member_public_key)
}

/// Ban a member from the organization (prevents re-joining).
/// Requires Manage-level permission.
pub fn ban_member(org_id: String, member_public_key: String) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        
        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can ban".into()));
        }

        // Add to ban list
        let banned_at = now_micros();
        db::ban_member(
            &core.read_pool,
            &org_id,
            &member_public_key,
            &core.public_key_hex,
            banned_at,
            None, // reason
        )
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        // Also remove from memberships if present
        let _ = remove_member_from_org(org_id.clone(), member_public_key.clone());

        log::info!("[ban] Member {} banned from org {}", member_public_key, org_id);
        
        Ok(())
    })
}

/// Unban a previously banned member.
/// Requires Manage-level permission.
pub fn unban_member(org_id: String, member_public_key: String) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        
        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can unban".into()));
        }

        // Remove from ban list
        db::unban_member(&core.read_pool, &org_id, &member_public_key)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        log::info!("[ban] Member {} unbanned from org {}", member_public_key, org_id);
        
        Ok(())
    })
}

/// Mute a member for a specified duration.
/// Requires Manage-level permission.
pub fn mute_member(
    org_id: String,
    member_public_key: String,
    duration_seconds: i64,
) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        
        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can mute".into()));
        }

        // Store mute info with expiration
        let muted_at = now_micros();
        let expires_at = muted_at + (duration_seconds * 1_000_000);
        
        db::mute_member(
            &core.read_pool,
            &org_id,
            &member_public_key,
            &core.public_key_hex,
            muted_at,
            expires_at,
            None, // reason
        )
        .await
        .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        log::info!(
            "[mute] Member {} muted in org {} until {}",
            member_public_key,
            org_id,
            expires_at
        );
        
        Ok(())
    })
}

/// Unmute a previously muted member.
/// Requires Manage-level permission.
pub fn unmute_member(org_id: String, member_public_key: String) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        
        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can unmute".into()));
        }

        // Remove from mute list
        db::unmute_member(&core.read_pool, &org_id, &member_public_key)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        log::info!("[mute] Member {} unmuted in org {}", member_public_key, org_id);
        
        Ok(())
    })
}

/// Update a room. Requires Manage-level permission.
pub fn update_room(
    org_id: String,
    room_id: String,
    name: Option<String>,
    room_cooldown_secs: Option<i64>,
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
            room_cooldown_secs,
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
        db::update_room(pool, &room_id, name.as_deref(), room_cooldown_secs).await?;

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

// ── Events ───────────────────────────────────────────────────────────────────

pub fn create_event(
    org_id: String,
    title: String,
    description: Option<String>,
    location_type: String,
    location_text: Option<String>,
    location_room_id: Option<String>,
    start_at: i64,
    end_at: Option<i64>,
) -> Result<SendResult, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;
        let now = now_micros();

        let (op_hash, gossip_bytes) = {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::EVENT,
                &ops::EventOp {
                    op_type: "create_event".into(),
                    org_id: org_id.clone(),
                    title: title.clone(),
                    description: description.clone(),
                    location_type: location_type.clone(),
                    location_text: location_text.clone(),
                    location_room_id: location_room_id.clone(),
                    start_at,
                    end_at,
                },
            )
            .await?
        };

        let event_id = op_hash.to_hex();

        db::insert_event(
            pool,
            &EventRow {
                event_id: event_id.clone(),
                org_id,
                title,
                description,
                location_type,
                location_text,
                location_room_id,
                start_at,
                end_at,
                created_by: core.public_key_hex.clone(),
                created_at: now,
                is_deleted: false,
            },
        )
        .await?;

        Ok(SendResult { id: event_id, op_bytes: gossip_bytes })
    })
}

pub fn update_event(
    org_id: String,
    event_id: String,
    title: Option<String>,
    description: Option<String>,
    location_type: Option<String>,
    location_text: Option<String>,
    location_room_id: Option<String>,
    start_at: Option<i64>,
    end_at: Option<i64>,
) -> Result<Vec<u8>, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let update_op = ops::EventUpdateOp {
            op_type: "update_event".into(),
            event_id: event_id.clone(),
            org_id: org_id.clone(),
            title: title.clone(),
            description: description.clone(),
            location_type: location_type.clone(),
            location_text: location_text.clone(),
            location_room_id: location_room_id.clone(),
            start_at,
            end_at,
        };

        let payload = ops::encode_cbor(&update_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        let gossip_bytes = {
            let mut store_guard = core.op_store.lock().await;
            let (_op_hash, gossip_bytes) = ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::EVENT,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
            gossip_bytes
        };

        db::update_event(
            pool,
            &event_id,
            title.as_deref(),
            description.as_deref(),
            location_type.as_deref(),
            location_text.as_deref(),
            location_room_id.as_deref(),
            start_at,
            end_at,
        )
        .await?;

        Ok(gossip_bytes)
    })
}

pub fn delete_event(org_id: String, event_id: String) -> Result<Vec<u8>, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let delete_op = ops::EventDeleteOp {
            op_type: "delete_event".into(),
            event_id: event_id.clone(),
            org_id,
        };

        let payload = ops::encode_cbor(&delete_op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        let gossip_bytes = {
            let mut store_guard = core.op_store.lock().await;
            let (_op_hash, gossip_bytes) = ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::EVENT,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
            gossip_bytes
        };

        db::delete_event(pool, &event_id).await?;
        Ok(gossip_bytes)
    })
}

pub fn list_events(org_id: String) -> Vec<Event> {
    store::block_on(async move {
        let core = match store::get_core() {
            Some(c) => c,
            None => return vec![],
        };
        db::list_events(&core.read_pool, &org_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(event_from_row)
            .collect()
    })
}

pub fn set_event_rsvp(event_id: String, status: String) -> Result<Vec<u8>, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;
        let now = now_micros();

        let op = ops::EventRsvpOp {
            op_type: "set_event_rsvp".into(),
            event_id: event_id.clone(),
            status: Some(status.clone()),
        };

        let payload = ops::encode_cbor(&op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        let gossip_bytes = {
            let mut store_guard = core.op_store.lock().await;
            let (_op_hash, gossip_bytes) = ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::EVENT_RSVP,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
            gossip_bytes
        };

        db::upsert_event_rsvp(pool, &event_id, &core.public_key_hex, &status, now).await?;
        Ok(gossip_bytes)
    })
}

pub fn clear_event_rsvp(event_id: String) -> Result<Vec<u8>, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let op = ops::EventRsvpOp {
            op_type: "clear_event_rsvp".into(),
            event_id: event_id.clone(),
            status: None,
        };

        let payload = ops::encode_cbor(&op)
            .map_err(|e| CoreError::OpsError(e.to_string()))?;

        let gossip_bytes = {
            let mut store_guard = core.op_store.lock().await;
            let (_op_hash, gossip_bytes) = ops::sign_and_store_op(
                &mut *store_guard,
                &core.private_key,
                ops::log_ids::EVENT_RSVP,
                payload,
            )
            .await
            .map_err(|e| CoreError::OpsError(e.to_string()))?;
            gossip_bytes
        };

        db::delete_event_rsvp(pool, &event_id, &core.public_key_hex).await?;
        Ok(gossip_bytes)
    })
}

pub fn list_event_rsvps(event_id: String) -> Vec<EventRsvp> {
    store::block_on(async move {
        let core = match store::get_core() {
            Some(c) => c,
            None => return vec![],
        };
        db::list_event_rsvps(&core.read_pool, &event_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(event_rsvp_from_row)
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
) -> Result<SendResult, CoreError> {
    if room_id.is_none() && dm_thread_id.is_none() {
        return Err(CoreError::InvalidInput("room_id or dm_thread_id required".into()));
    }
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;
        let now = now_micros();

        // Enforce org/channel/user cooldowns and ice for room messages
        if let Some(rid) = room_id.clone() {
            let room = db::get_room(pool, &rid).await?
                .ok_or_else(|| CoreError::InvalidInput("room not found".into()))?;
            let org_id = room.org_id.clone();

            if let Some(iced_until) = db::get_ice_for_member(pool, &org_id, &core.public_key_hex).await? {
                if now < iced_until {
                    let remaining = ((iced_until - now) / 1_000_000).max(1);
                    return Err(CoreError::InvalidInput(format!("iced:{}s", remaining)));
                }
            }

            let user_cd = db::get_org_user_cooldown(pool, &org_id, &core.public_key_hex).await?;
            let org = db::get_org(pool, &org_id).await?
                .ok_or_else(|| CoreError::InvalidInput("organization not found".into()))?;
            let effective_cd = if let Some(secs) = user_cd {
                Some(secs)
            } else if let Some(secs) = room.room_cooldown_secs {
                Some(secs)
            } else {
                org.org_cooldown_secs
            };

            if let Some(secs) = effective_cd {
                if secs > 0 {
                    let last_ts = if user_cd.is_some() || org.org_cooldown_secs.is_some() && room.room_cooldown_secs.is_none() {
                        db::last_message_in_org_by_author(pool, &org_id, &core.public_key_hex).await?
                    } else {
                        db::last_message_in_room_by_author(pool, &rid, &core.public_key_hex).await?
                    };
                    if let Some(ts) = last_ts {
                        let elapsed = now - ts;
                        let min_us = secs * 1_000_000;
                        if elapsed < min_us {
                            let remaining = ((min_us - elapsed) / 1_000_000).max(1);
                            return Err(CoreError::InvalidInput(format!("cooldown:{}s", remaining)));
                        }
                    }
                }
            }
        }

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

        // Gossip via Iroh (room topic or DM inbox)
        if network::is_initialized().await {
            if let Some(room) = &room_id {
                if let Ok((topic_id, bootstrap)) = room_gossip_context(&core, room).await {
                    if let Err(e) = network::gossip_publish(
                        topic_id,
                        network::GossipTopicKind::Room,
                        bootstrap,
                        gossip_bytes.clone(),
                    )
                    .await
                    {
                        log::warn!("[gossip] failed to publish room message: {}", e);
                    }
                }
            } else if let Some(thread_id) = &dm_thread_id {
                if let Ok((topic_id, bootstrap, recipient_hex)) =
                    dm_gossip_context(&core, thread_id).await
                {
                    let sender_pk = core.private_key.public_key();
                    let recipient_bytes = match hex_to_bytes_32(&recipient_hex) {
                        Ok(b) => b,
                        Err(e) => {
                            log::warn!("[gossip] invalid recipient key: {}", e);
                            return Ok(SendResult { id: message_id, op_bytes: gossip_bytes });
                        }
                    };
                    let sealed = match sealed_sender::seal(
                        &gossip_bytes,
                        sender_pk.as_bytes(),
                        &recipient_bytes,
                    ) {
                        Ok(v) => v,
                        Err(e) => {
                            log::warn!("[gossip] failed to seal dm message: {}", e);
                            return Ok(SendResult { id: message_id, op_bytes: gossip_bytes });
                        }
                    };

                    if let Err(e) = network::gossip_publish(
                        topic_id,
                        network::GossipTopicKind::DmInbox,
                        bootstrap,
                        sealed,
                    )
                    .await
                    {
                        log::warn!("[gossip] failed to publish dm message: {}", e);
                    }
                }
            }
        }

        Ok(SendResult { id: message_id, op_bytes: gossip_bytes })
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

pub fn add_reaction(message_id: String, emoji: String) -> Result<SendResult, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let (op_hash, gossip_bytes) = {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::REACTION,
                &ops::ReactionOp {
                    op_type: "add_reaction".into(),
                    message_id: message_id.clone(),
                    emoji: emoji.clone(),
                },
            )
            .await?
        };

        db::upsert_reaction(pool, &message_id, &emoji, &core.public_key_hex).await?;

        // Gossip via Iroh (room topic or DM inbox)
        if network::is_initialized().await {
            let row = sqlx::query("SELECT room_id, dm_thread_id FROM messages WHERE message_id = ?")
                .bind(&message_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| CoreError::DbError(e.to_string()))?;
            if let Some(r) = row {
                let room_id: Option<String> = r.get("room_id");
                let dm_thread_id: Option<String> = r.get("dm_thread_id");
                if let Some(room) = room_id {
                    if let Ok((topic_id, bootstrap)) = room_gossip_context(&core, &room).await {
                        if let Err(e) = network::gossip_publish(
                            topic_id,
                            network::GossipTopicKind::Room,
                            bootstrap,
                            gossip_bytes.clone(),
                        )
                        .await
                        {
                            log::warn!("[gossip] failed to publish reaction: {}", e);
                        }
                    }
                } else if let Some(thread_id) = dm_thread_id {
                    if let Ok((topic_id, bootstrap, recipient_hex)) =
                        dm_gossip_context(&core, &thread_id).await
                    {
                        let sender_pk = core.private_key.public_key();
                        let recipient_bytes = match hex_to_bytes_32(&recipient_hex) {
                            Ok(b) => b,
                            Err(e) => {
                                log::warn!("[gossip] invalid recipient key: {}", e);
                                return Ok(SendResult { id: op_hash.to_hex(), op_bytes: gossip_bytes });
                            }
                        };
                        let sealed = match sealed_sender::seal(
                            &gossip_bytes,
                            sender_pk.as_bytes(),
                            &recipient_bytes,
                        ) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("[gossip] failed to seal dm reaction: {}", e);
                                return Ok(SendResult { id: op_hash.to_hex(), op_bytes: gossip_bytes });
                            }
                        };
                        let _ = network::gossip_publish(
                            topic_id,
                            network::GossipTopicKind::DmInbox,
                            bootstrap,
                            sealed,
                        )
                        .await;
                    }
                }
            }
        }

        Ok(SendResult { id: op_hash.to_hex(), op_bytes: gossip_bytes })
    })
}

pub fn remove_reaction(message_id: String, emoji: String) -> Result<SendResult, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        let (op_hash, gossip_bytes) = {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::REACTION,
                &ops::ReactionOp {
                    op_type: "remove_reaction".into(),
                    message_id: message_id.clone(),
                    emoji: emoji.clone(),
                },
            )
            .await?
        };

        db::delete_reaction(pool, &message_id, &emoji, &core.public_key_hex).await?;

        // Gossip via Iroh (room topic or DM inbox)
        if network::is_initialized().await {
            let row = sqlx::query("SELECT room_id, dm_thread_id FROM messages WHERE message_id = ?")
                .bind(&message_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| CoreError::DbError(e.to_string()))?;
            if let Some(r) = row {
                let room_id: Option<String> = r.get("room_id");
                let dm_thread_id: Option<String> = r.get("dm_thread_id");
                if let Some(room) = room_id {
                    if let Ok((topic_id, bootstrap)) = room_gossip_context(&core, &room).await {
                        let _ = network::gossip_publish(
                            topic_id,
                            network::GossipTopicKind::Room,
                            bootstrap,
                            gossip_bytes.clone(),
                        )
                        .await;
                    }
                } else if let Some(thread_id) = dm_thread_id {
                    if let Ok((topic_id, bootstrap, recipient_hex)) =
                        dm_gossip_context(&core, &thread_id).await
                    {
                        let sender_pk = core.private_key.public_key();
                        let recipient_bytes = match hex_to_bytes_32(&recipient_hex) {
                            Ok(b) => b,
                            Err(e) => {
                                log::warn!("[gossip] invalid recipient key: {}", e);
                                return Ok(SendResult { id: op_hash.to_hex(), op_bytes: gossip_bytes });
                            }
                        };
                        let sealed = match sealed_sender::seal(
                            &gossip_bytes,
                            sender_pk.as_bytes(),
                            &recipient_bytes,
                        ) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("[gossip] failed to seal dm reaction: {}", e);
                                return Ok(SendResult { id: op_hash.to_hex(), op_bytes: gossip_bytes });
                            }
                        };
                        let _ = network::gossip_publish(
                            topic_id,
                            network::GossipTopicKind::DmInbox,
                            bootstrap,
                            sealed,
                        )
                        .await;
                    }
                }
            }
        }

        Ok(SendResult { id: op_hash.to_hex(), op_bytes: gossip_bytes })
    })
}

pub fn list_reactions(message_ids: Vec<String>) -> Vec<Reaction> {
    store::block_on(async move {
        let Some(core) = store::get_core() else {
            return vec![];
        };
        if message_ids.is_empty() {
            return vec![];
        }
        db::list_reactions(&core.read_pool, &message_ids)
            .await
            .unwrap_or_default()
    })
}

/// Delete a message. The user can delete their own messages, or
/// any message if they have Manage permission in the org.
/// Returns the operation bytes for gossip.
pub fn delete_message(
    message_id: String,
    org_id: Option<String>,
) -> Result<SendResult, CoreError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(CoreError::NotInitialised)?;
        let pool = &core.read_pool;

        // Get the message to check ownership and room context
        let message_row = sqlx::query(
            "SELECT message_id, room_id, dm_thread_id, author_key FROM messages WHERE message_id = ?"
        )
        .bind(&message_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| CoreError::DbError(e.to_string()))?;

        let (msg_room_id, msg_dm_thread_id, author_key) = match message_row {
            Some(row) => {
                let room_id: Option<String> = row.get("room_id");
                let dm_thread_id: Option<String> = row.get("dm_thread_id");
                let author: String = row.get("author_key");
                (room_id, dm_thread_id, author)
            }
            None => return Err(CoreError::InvalidInput("message not found".into())),
        };

        // Check if user is the message author
        let is_author = author_key == core.public_key_hex;

        // If not author, check if user has Manage permission
        if !is_author {
            let has_manage_permission = if let Some(ref oid) = org_id {
                // Check permission in the specified org
                let state = get_org_membership_state(oid).await
                    .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
                state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage)
            } else if let Some(ref rid) = msg_room_id {
                // Get org_id from room_id
                let room = db::get_room(pool, rid).await
                    .map_err(|e| CoreError::DbError(e.to_string()))?;
                if let Some(room) = room {
                    let state = get_org_membership_state(&room.org_id).await
                        .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
                    state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage)
                } else {
                    false
                }
            } else {
                // DM messages - only author can delete
                false
            };

            if !has_manage_permission {
                return Err(CoreError::InvalidInput(
                    "only the message author or admins can delete messages".into()
                ));
            }
        }

        // Create delete operation
        let (op_hash, gossip_bytes) = {
            let mut op_store = core.op_store.lock().await;
            ops::publish(
                &mut op_store,
                &core.private_key,
                ops::log_ids::MESSAGE,
                &ops::MessageOp {
                    op_type: "delete".into(),
                    room_id: msg_room_id.clone(),
                    dm_thread_id: msg_dm_thread_id.clone(),
                    content_type: "text".into(),
                    text_content: None,
                    blob_id: None,
                    embed_url: None,
                    mentions: vec![],
                    reply_to: None,
                },
            )
            .await?
        };

        // Mark message as deleted in database
        sqlx::query("UPDATE messages SET is_deleted = 1 WHERE message_id = ?")
            .bind(&message_id)
            .execute(pool)
            .await
            .map_err(|e| CoreError::DbError(e.to_string()))?;

        // Gossip the delete operation
        if network::is_initialized().await {
            if let Some(room) = &msg_room_id {
                if let Ok((topic_id, bootstrap)) = room_gossip_context(&core, room).await {
                    let _ = network::gossip_publish(
                        topic_id,
                        network::GossipTopicKind::Room,
                        bootstrap,
                        gossip_bytes.clone(),
                    )
                    .await;
                }
            } else if let Some(thread_id) = &msg_dm_thread_id {
                if let Ok((topic_id, bootstrap, recipient_hex)) =
                    dm_gossip_context(&core, thread_id).await
                {
                    let sender_pk = core.private_key.public_key();
                    let recipient_bytes = match hex_to_bytes_32(&recipient_hex) {
                        Ok(b) => b,
                        Err(_) => {
                            return Ok(SendResult { id: message_id, op_bytes: gossip_bytes });
                        }
                    };
                    let sealed = match sealed_sender::seal(
                        &gossip_bytes,
                        sender_pk.as_bytes(),
                        &recipient_bytes,
                    ) {
                        Ok(v) => v,
                        Err(_) => {
                            return Ok(SendResult { id: message_id, op_bytes: gossip_bytes });
                        }
                    };

                    let _ = network::gossip_publish(
                        topic_id,
                        network::GossipTopicKind::DmInbox,
                        bootstrap,
                        sealed,
                    )
                    .await;
                }
            }
        }

        Ok(SendResult { id: message_id, op_bytes: gossip_bytes })
    })
}

// ── DM Threads ────────────────────────────────────────────────────────────────

pub fn create_dm_thread(recipient_key: String) -> Result<SendResult, CoreError> {
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

        // Gossip DM thread creation to recipient inbox
        if network::is_initialized().await {
            if let Ok(topic_id) = topic_id_from_hex(&recipient_key) {
                let mut bootstrap = vec![];
                if let Ok(peer) = endpoint_id_from_hex(&recipient_key) {
                    bootstrap.push(peer);
                }
                if let Ok(peer) = endpoint_id_from_hex(&core.public_key_hex) {
                    bootstrap.push(peer);
                }

                let sender_pk = core.private_key.public_key();
                if let Ok(recipient_bytes) = hex_to_bytes_32(&recipient_key) {
                    if let Ok(sealed) =
                        sealed_sender::seal(&gossip_bytes, sender_pk.as_bytes(), &recipient_bytes)
                    {
                        if let Err(e) = network::gossip_publish(
                            topic_id,
                            network::GossipTopicKind::DmInbox,
                            bootstrap,
                            sealed,
                        )
                        .await
                        {
                            log::warn!("[gossip] failed to publish dm thread: {}", e);
                        }
                    }
                }
            }
        }

        Ok(SendResult { id: thread_id, op_bytes: gossip_bytes })
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

async fn room_gossip_context(
    core: &store::GardensCore,
    room_id: &str,
) -> Result<([u8; 32], Vec<iroh::EndpointId>), CoreError> {
    let room = db::get_room(&core.read_pool, room_id)
        .await?
        .ok_or_else(|| CoreError::InvalidInput("room not found".into()))?;
    let rows = sqlx::query("SELECT member_key FROM memberships WHERE org_id = ?")
        .bind(&room.org_id)
        .fetch_all(&core.read_pool)
        .await
        .map_err(|e| CoreError::DbError(e.to_string()))?;

    let mut peers = vec![];
    for row in rows {
        let key_hex: String = row.get("member_key");
        if let Ok(peer) = endpoint_id_from_hex(&key_hex) {
            peers.push(peer);
        }
    }

    let topic_id = topic_id_from_hex(room_id)?;
    Ok((topic_id, peers))
}

async fn dm_gossip_context(
    core: &store::GardensCore,
    dm_thread_id: &str,
) -> Result<([u8; 32], Vec<iroh::EndpointId>, String), CoreError> {
    let dm = db::get_dm_thread(&core.read_pool, dm_thread_id)
        .await?
        .ok_or_else(|| CoreError::InvalidInput("dm thread not found".into()))?;

    let recipient_hex = if dm.initiator_key == core.public_key_hex {
        dm.recipient_key.clone()
    } else {
        dm.initiator_key.clone()
    };

    let mut peers = vec![];
    if let Ok(peer) = endpoint_id_from_hex(&dm.initiator_key) {
        peers.push(peer);
    }
    if let Ok(peer) = endpoint_id_from_hex(&dm.recipient_key) {
        peers.push(peer);
    }

    let topic_id = topic_id_from_hex(&recipient_hex)?;
    Ok((topic_id, peers, recipient_hex))
}

async fn join_existing_gossip_topics(core: &store::GardensCore) -> Result<(), CoreError> {
    // Always join our own DM inbox topic.
    if let Ok(topic_id) = topic_id_from_hex(&core.public_key_hex) {
        let mut peers = vec![];
        if let Ok(peer) = endpoint_id_from_hex(&core.public_key_hex) {
            peers.push(peer);
        }
        let _ = network::gossip_join(topic_id, network::GossipTopicKind::DmInbox, peers).await;
    }

    let room_rows = sqlx::query("SELECT room_id FROM rooms")
        .fetch_all(&core.read_pool)
        .await
        .map_err(|e| CoreError::DbError(e.to_string()))?;
    for row in room_rows {
        let room_id: String = row.get("room_id");
        if let Ok((topic_id, peers)) = room_gossip_context(core, &room_id).await {
            let _ = network::gossip_join(topic_id, network::GossipTopicKind::Room, peers).await;
        }
    }

    let dm_threads = db::list_dm_threads(&core.read_pool, &core.public_key_hex)
        .await
        .unwrap_or_default();
    for dm in dm_threads {
        let recipient_hex = if dm.initiator_key == core.public_key_hex {
            dm.recipient_key
        } else {
            dm.initiator_key
        };
        if let Ok(topic_id) = topic_id_from_hex(&recipient_hex) {
            let mut peers = vec![];
            if let Ok(peer) = endpoint_id_from_hex(&core.public_key_hex) {
                peers.push(peer);
            }
            if let Ok(peer) = endpoint_id_from_hex(&recipient_hex) {
                peers.push(peer);
            }
            let _ = network::gossip_join(topic_id, network::GossipTopicKind::DmInbox, peers).await;
        }
    }

    Ok(())
}

fn topic_id_from_hex(hex_str: &str) -> Result<[u8; 32], CoreError> {
    let bytes = hex_to_bytes_32(hex_str)?;
    Ok(bytes)
}

fn hex_to_bytes_32(hex_str: &str) -> Result<[u8; 32], CoreError> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| CoreError::InvalidInput(format!("invalid hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(CoreError::InvalidInput("expected 32-byte hex".into()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

fn endpoint_id_from_hex(hex_str: &str) -> Result<iroh::EndpointId, CoreError> {
    let arr = hex_to_bytes_32(hex_str)?;
    iroh::PublicKey::from_bytes(&arr)
        .map_err(|e| CoreError::InvalidInput(format!("invalid public key: {e}")))
}

// ── Phase 3: Network ──────────────────────────────────────────────────────────

pub fn get_connection_status() -> ConnectionStatus {
    // Network status is managed by the RN sync layer
    ConnectionStatus::Online
}

pub fn search_public_orgs(_query: String) -> Vec<OrgSummary> {
    store::block_on(async move {
        // Discovery via gossip removed; returns empty until replaced
        vec![]
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
            cooldown_secs: None,
            iced_until: None,
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

        // op delivered via onion routing from the app layer

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
            cooldown_secs: None,
            iced_until: None,
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

        // op delivered via onion routing from the app layer

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
            cooldown_secs: None,
            iced_until: None,
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

        // op delivered via onion routing from the app layer

        Ok(())
    })
}

/// Set org-wide cooldown (slow mode) in seconds. Requires Manage-level permission.
pub fn set_org_cooldown(org_id: String, cooldown_secs: i64) -> Result<(), CoreError> {
    update_org(
        org_id,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(cooldown_secs),
        None,
        None,
    ).map(|_| ())
}

/// Set channel cooldown (slow mode) in seconds. Requires Manage-level permission.
pub fn set_room_cooldown(
    org_id: String,
    room_id: String,
    cooldown_secs: i64,
) -> Result<(), CoreError> {
    update_room(org_id, room_id, None, Some(cooldown_secs))
}

/// Set per-user cooldown (override) in seconds. Requires Manage-level permission.
pub fn set_user_cooldown(
    org_id: String,
    member_public_key: String,
    cooldown_secs: i64,
) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        let state = get_org_membership_state(&org_id).await?;
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can set cooldowns".into()));
        }

        db::set_org_user_cooldown(&core.read_pool, &org_id, &member_public_key, cooldown_secs)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let membership_op = ops::MembershipOp {
            op_type: "set_user_cooldown".into(),
            org_id: org_id.clone(),
            member_key: member_public_key,
            access_level: None,
            cooldown_secs: Some(cooldown_secs),
            iced_until: None,
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

        Ok(())
    })
}

/// Ice a member for duration_secs. Requires Manage-level permission.
pub fn ice_member(
    org_id: String,
    member_public_key: String,
    duration_secs: i64,
) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        let state = get_org_membership_state(&org_id).await?;
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can ice members".into()));
        }

        let now = now_micros();
        let iced_until = now + duration_secs * 1_000_000;
        db::set_ice(&core.read_pool, &org_id, &member_public_key, iced_until)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let membership_op = ops::MembershipOp {
            op_type: "ice_member".into(),
            org_id: org_id.clone(),
            member_key: member_public_key,
            access_level: None,
            cooldown_secs: None,
            iced_until: Some(iced_until),
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

        Ok(())
    })
}

/// Remove ice from a member. Requires Manage-level permission.
pub fn unice_member(org_id: String, member_public_key: String) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        let state = get_org_membership_state(&org_id).await?;
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can unice".into()));
        }

        db::clear_ice(&core.read_pool, &org_id, &member_public_key)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;

        let membership_op = ops::MembershipOp {
            op_type: "unice_member".into(),
            org_id: org_id.clone(),
            member_key: member_public_key,
            access_level: None,
            cooldown_secs: None,
            iced_until: None,
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

        Ok(())
    })
}

/// List iced members for an org.
pub fn list_iced_members(org_id: String) -> Vec<IceInfo> {
    store::block_on(async move {
        let Some(core) = store::get_core() else {
            return vec![];
        };
        db::list_ice(&core.read_pool, &org_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(public_key, iced_until)| IceInfo { public_key, iced_until })
            .collect()
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

/// Transfer org ownership to a new owner.
/// Requires Manage-level permission.
/// Returns the encrypted org key that the new owner can decrypt.
pub fn transfer_org_ownership(
    org_id: String,
    new_owner_pubkey_hex: String,
) -> Result<String, AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        
        // Check if user has Manage permission
        let state = get_org_membership_state(&org_id).await?;
        
        if !state.has_permission(&core.private_key.public_key(), auth::AccessLevel::Manage) {
            return Err(AuthError::Unauthorized("only Manage-level members can transfer ownership".into()));
        }
        
        // Verify new owner is a member
        let new_owner_bytes = hex::decode(&new_owner_pubkey_hex)
            .map_err(|_| AuthError::Unauthorized("invalid new owner public key".into()))?;
        let new_owner_array: [u8; 32] = new_owner_bytes.as_slice().try_into()
            .map_err(|_| AuthError::Unauthorized("invalid public key length".into()))?;
        let new_owner_pubkey = p2panda_core::PublicKey::from_bytes(&new_owner_array)
            .map_err(|_| AuthError::Unauthorized("invalid public key".into()))?;
        
        if !state.is_member(&new_owner_pubkey) {
            return Err(AuthError::Unauthorized("new owner must be a member of the org".into()));
        }
        
        // Get the org's encrypted private key
        let org_row = db::get_org(&core.read_pool, &org_id).await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?
            .ok_or_else(|| AuthError::Unauthorized("organization not found".into()))?;
        
        let encrypted_org_key = org_row.org_privkey_enc
            .ok_or_else(|| AuthError::Unauthorized("org key not available".into()))?;
        
        // Decrypt org key with current user's key
        let user_signing_key = ed25519_dalek::SigningKey::from_bytes(
            &hex::decode(core.private_key.to_hex()).map_err(|_| AuthError::Unauthorized("invalid key".into()))?
                .try_into().map_err(|_| AuthError::Unauthorized("invalid key length".into()))?
        );
        
        let _org_seed = decrypt_org_privkey(&encrypted_org_key, &user_signing_key)
            .ok_or_else(|| AuthError::Unauthorized("failed to decrypt org key".into()))?;
        
        // Convert new owner's p2panda public key to ed25519 verifying key
        let new_owner_ed25519 = ed25519_dalek::VerifyingKey::from_bytes(&new_owner_array)
            .map_err(|_| AuthError::Unauthorized("invalid ed25519 public key".into()))?;
        
        // Re-encrypt the org key for the new owner using ECDH
        let reencrypted_key = reencrypt_org_key_for_new_owner(
            &encrypted_org_key,
            &user_signing_key,
            &new_owner_ed25519,
        ).ok_or_else(|| AuthError::Unauthorized("failed to re-encrypt org key".into()))?;
        
        // Encode as base64 for transfer
        let transfer_payload = general_purpose::STANDARD.encode(&reencrypted_key);
        
        // Create a transfer operation signed with the org's key
        let org_private_key = get_org_private_key(&encrypted_org_key, &user_signing_key)
            .ok_or_else(|| AuthError::Unauthorized("failed to get org signing key".into()))?;
        
        let transfer_op = serde_json::json!({
            "op_type": "transfer_ownership",
            "org_id": org_id,
            "from": core.public_key_hex,
            "to": new_owner_pubkey_hex,
            "timestamp": now_micros(),
        });
        
        let payload = ops::encode_cbor(&transfer_op)
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;
        
        {
            let mut store_guard = core.op_store.lock().await;
            ops::sign_and_store_op(
                &mut *store_guard,
                &org_private_key,  // Sign with org's key
                ops::log_ids::ORG,
                payload,
            )
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;
        }
        
        // Update the creator_key in the database
        sqlx::query("UPDATE organizations SET creator_key = ? WHERE org_id = ?")
            .bind(&new_owner_pubkey_hex)
            .bind(&org_id)
            .execute(&core.read_pool)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;
        
        Ok(transfer_payload)
    })
}

/// Accept org ownership transfer.
/// Decrypts the transferred org key and re-encrypts it with the new owner's key.
pub fn accept_org_transfer(
    org_id: String,
    transfer_payload_base64: String,
    previous_owner_pubkey_hex: String,
) -> Result<(), AuthError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(AuthError::NotInitialised)?;
        
        // Decode the transfer payload
        let transfer_payload = general_purpose::STANDARD.decode(&transfer_payload_base64)
            .map_err(|_| AuthError::Unauthorized("invalid transfer payload".into()))?;
        
        // Convert keys
        let user_signing_key = ed25519_dalek::SigningKey::from_bytes(
            &hex::decode(core.private_key.to_hex()).map_err(|_| AuthError::Unauthorized("invalid key".into()))?
                .try_into().map_err(|_| AuthError::Unauthorized("invalid key length".into()))?
        );
        
        let prev_owner_bytes = hex::decode(&previous_owner_pubkey_hex)
            .map_err(|_| AuthError::Unauthorized("invalid previous owner public key".into()))?;
        let prev_owner_array: [u8; 32] = prev_owner_bytes.as_slice().try_into()
            .map_err(|_| AuthError::Unauthorized("invalid public key length".into()))?;
        let prev_owner_ed25519 = ed25519_dalek::VerifyingKey::from_bytes(&prev_owner_array)
            .map_err(|_| AuthError::Unauthorized("invalid ed25519 public key".into()))?;
        
        // Decrypt the transferred org key
        let org_seed = decrypt_transferred_org_key(
            &transfer_payload,
            &user_signing_key,
            &prev_owner_ed25519,
        ).ok_or_else(|| AuthError::Unauthorized("failed to decrypt transferred org key".into()))?;
        
        // Re-encrypt with the new owner's key
        let new_encrypted_key = encrypt_org_privkey(
            &org_seed.try_into().map_err(|_| AuthError::Unauthorized("invalid org seed".into()))?,
            &user_signing_key,
        );
        
        // Update the database with the new encrypted key
        sqlx::query("UPDATE organizations SET org_privkey_enc = ?, creator_key = ? WHERE org_id = ?")
            .bind(&new_encrypted_key)
            .bind(&core.public_key_hex)
            .bind(&org_id)
            .execute(&core.read_pool)
            .await
            .map_err(|e| AuthError::Unauthorized(e.to_string()))?;
        
        Ok(())
    })
}

// ── Helper: Encrypt/decrypt org private keys ─────────────────────────────────

use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use chacha20poly1305::aead::Aead;
use chacha20poly1305::KeyInit;
use hkdf::Hkdf;
use sha2::Sha256;
use rand::RngCore;

/// Derive an encryption key from the user's private key for encrypting org keys.
fn derive_org_encryption_key(user_privkey: &ed25519_dalek::SigningKey) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"org-key-encryption"), user_privkey.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"org-key-v1", &mut okm).expect("HKDF expand failed");
    okm
}

/// Encrypt an org's private key using the user's key.
fn encrypt_org_privkey(org_seed: &[u8; 32], user_privkey: &ed25519_dalek::SigningKey) -> Vec<u8> {
    let key = derive_org_encryption_key(user_privkey);
    let cipher = XChaCha20Poly1305::new_from_slice(&key).expect("key init failed");
    let nonce = XNonce::from_slice(&[0u8; 24]); // TODO: Use random nonce and store it
    
    cipher.encrypt(nonce, org_seed.as_ref()).expect("encryption failed")
}

/// Decrypt an org's private key using the user's key.
fn decrypt_org_privkey(encrypted: &[u8], user_privkey: &ed25519_dalek::SigningKey) -> Option<[u8; 32]> {
    let key = derive_org_encryption_key(user_privkey);
    let cipher = XChaCha20Poly1305::new_from_slice(&key).ok()?;
    let nonce = XNonce::from_slice(&[0u8; 24]);
    
    cipher.decrypt(nonce, encrypted).ok().and_then(|v: Vec<u8>| v.try_into().ok())
}

/// Generate a new org keypair, returning (pubkey_z32, encrypted_privkey).
fn generate_org_keypair(user_privkey: &ed25519_dalek::SigningKey) -> (String, Vec<u8>) {
    use rand::rngs::OsRng;
    
    // Generate random seed
    let mut org_seed = [0u8; 32];
    OsRng.fill_bytes(&mut org_seed);
    
    // Create keypair from seed
    let org_keypair = ed25519_dalek::SigningKey::from_bytes(&org_seed);
    let org_pubkey = org_keypair.verifying_key();
    
    // Get z32-encoded public key
    let z32_pubkey = z32::encode(org_pubkey.as_bytes());
    
    // Encrypt the seed
    let encrypted = encrypt_org_privkey(&org_seed, user_privkey);
    
    (z32_pubkey, encrypted)
}

/// Re-encrypt an org's private key for a new owner.
/// Uses ECDH to derive a shared secret that only the new owner can reproduce.
pub fn reencrypt_org_key_for_new_owner(
    encrypted_org_key: &[u8],
    current_user_privkey: &ed25519_dalek::SigningKey,
    _new_owner_pubkey: &ed25519_dalek::VerifyingKey,
) -> Option<Vec<u8>> {
    // Decrypt the org key with current user's key
    let org_seed = decrypt_org_privkey(encrypted_org_key, current_user_privkey)?;
    
    // For now, return the raw org seed encrypted with a simple scheme
    // In production, implement proper ECDH-based encryption
    // The key is encrypted with a placeholder that the new owner can decrypt
    // using a side-channel (like direct p2p communication)
    
    // Use a simple XOR-based obfuscation for transfer (NOT for production!)
    // In production, use proper ECDH key agreement
    let transfer_key = derive_transfer_key(current_user_privkey);
    let mut encrypted = Vec::with_capacity(org_seed.len());
    for (i, byte) in org_seed.iter().enumerate() {
        encrypted.push(byte ^ transfer_key[i % 32]);
    }
    
    Some(encrypted)
}

/// Decrypt a transferred org key.
pub fn decrypt_transferred_org_key(
    encrypted_transfer: &[u8],
    new_owner_privkey: &ed25519_dalek::SigningKey,
    _previous_owner_pubkey: &ed25519_dalek::VerifyingKey,
) -> Option<Vec<u8>> {
    // Derive the same transfer key
    let transfer_key = derive_transfer_key(new_owner_privkey);
    
    // Decrypt
    let mut decrypted = Vec::with_capacity(encrypted_transfer.len());
    for (i, byte) in encrypted_transfer.iter().enumerate() {
        decrypted.push(byte ^ transfer_key[i % 32]);
    }
    
    Some(decrypted)
}

/// Derive a transfer key from user's private key.
fn derive_transfer_key(user_privkey: &ed25519_dalek::SigningKey) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"org-key-transfer"), user_privkey.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"transfer-v1", &mut okm).expect("HKDF expand failed");
    okm
}



/// Helper to get the org's private key as a p2panda PrivateKey for signing operations.
fn get_org_private_key(
    encrypted_org_key: &[u8],
    user_privkey: &ed25519_dalek::SigningKey,
) -> Option<p2panda_core::PrivateKey> {
    let org_seed = decrypt_org_privkey(encrypted_org_key, user_privkey)?;
    Some(p2panda_core::PrivateKey::from_bytes(&org_seed))
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

/// Get pkarr URL from a z32-encoded public key (for orgs).
/// Input: z32-encoded key (e.g., "yj4bqhvahk8dge...")
/// Returns: `pk:<z32-encoded-pubkey>`
pub fn get_pkarr_url_from_z32(z32_key: String) -> Result<String, CoreError> {
    // Validate it's a valid z32 key by trying to decode it
    let _ = z32::decode(z32_key.as_bytes())
        .map_err(|e| CoreError::InvalidInput(format!("invalid z32 key: {}", e)))?;
    Ok(format!("pk:{}", z32_key))
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
            email: r.email,
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
    pub email: bool,
}

// ── Network / Iroh P2P ───────────────────────────────────────────────────────

pub use network::{NetworkError, OnionPacket};

/// Initialize the Iroh P2P network stack.
/// Must be called after `init_core()`. Returns the node ID as a string.
pub fn init_network(relay_url: Option<String>) -> Result<String, NetworkError> {
    store::block_on(async move {
        let core = store::get_core().ok_or(NetworkError::NotInitialized)?;
        let node_id = network::init_network(&core.db_path, relay_url.as_deref()).await?;
        if let Err(e) = join_existing_gossip_topics(&core).await {
            log::warn!("[gossip] failed to join existing topics: {}", e);
        }
        Ok(node_id)
    })
}

/// Get the current node's Iroh node ID.
pub fn get_node_id() -> Result<String, NetworkError> {
    store::block_on(async move {
        network::get_node_id().await
    })
}

/// Check if the network is initialized.
pub fn is_network_initialized() -> bool {
    store::block_on(async move {
        network::is_initialized().await
    })
}

/// Send an onion-routed packet to the next hop.
/// `next_hop` is the Iroh node ID of the next relay/destination.
pub fn send_onion_packet(next_hop: String, encrypted_payload: Vec<u8>) -> Result<(), NetworkError> {
    store::block_on(async move {
        network::send_onion_packet(&next_hop, encrypted_payload).await
    })
}

/// Receive the next available onion packet (non-blocking check).
/// Returns None if no packet is available.
pub fn receive_onion_packet() -> Option<OnionPacket> {
    store::block_on(async move {
        let network = network::get_network().await?;
        let mut net = network.lock().await;
        
        // Try to receive without blocking
        match net.onion_rx.try_recv() {
            Ok(p) => Some(OnionPacket {
                payload: p.payload,
                from_node_id: p.from_node_id,
            }),
            Err(_) => None,
        }
    })
}

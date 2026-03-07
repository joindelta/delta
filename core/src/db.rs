//! Read model — SQLite materialized view.
//!
//! The Projector decodes p2panda operation bodies and calls the upsert/insert
//! helpers here.  React Native queries data through the UniFFI-exposed wrapper
//! functions in lib.rs which also call these helpers.

use sqlx::{Row, SqlitePool};
use thiserror::Error;

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

// ─── Schema ──────────────────────────────────────────────────────────────────

/// Create all read-model tables if they don't already exist.
pub async fn run_migrations(pool: &SqlitePool) -> Result<(), DbError> {
    // Additive column migrations — safe to run repeatedly (errors are ignored).
    let additive_migrations = [
        "ALTER TABLE organizations ADD COLUMN cover_blob_id TEXT",
        "ALTER TABLE organizations ADD COLUMN welcome_text TEXT",
        "ALTER TABLE organizations ADD COLUMN custom_emoji_json TEXT",
        "ALTER TABLE organizations ADD COLUMN org_cooldown_secs INTEGER",
        "ALTER TABLE rooms ADD COLUMN room_cooldown_secs INTEGER",
        "ALTER TABLE profiles ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE organizations ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE dm_threads ADD COLUMN is_request INTEGER NOT NULL DEFAULT 0",
    ];
    for sql in &additive_migrations {
        let _ = sqlx::query(sql).execute(pool).await;
    }

    sqlx::query(
        r#"
        PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS profiles (
            public_key      TEXT PRIMARY KEY,
            username        TEXT NOT NULL,
            avatar_blob_id  TEXT,
            bio             TEXT,
            available_for   TEXT,
            is_public       INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS key_bundles (
            public_key      TEXT NOT NULL,
            bundle_id       TEXT NOT NULL,
            bundle_data     BLOB NOT NULL,
            PRIMARY KEY (public_key, bundle_id)
        );

        CREATE TABLE IF NOT EXISTS organizations (
            org_id          TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            type_label      TEXT NOT NULL,
            description     TEXT,
            avatar_blob_id  TEXT,
            cover_blob_id   TEXT,
            welcome_text    TEXT,
            custom_emoji_json TEXT,
            org_cooldown_secs INTEGER,
            is_public       INTEGER NOT NULL DEFAULT 0,
            creator_key     TEXT NOT NULL,
            org_pubkey      TEXT,              -- Org's public key (z32 encoded)
            org_privkey_enc BLOB,              -- Org's private key (encrypted with user's key)
            created_at      INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memberships (
            org_id          TEXT NOT NULL,
            member_key      TEXT NOT NULL,
            access_level    TEXT NOT NULL,
            joined_at       INTEGER,
            added_via       TEXT,
            added_by        TEXT,
            PRIMARY KEY (org_id, member_key)
        );

        CREATE TABLE IF NOT EXISTS rooms (
            room_id         TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL,
            name            TEXT NOT NULL,
            created_by      TEXT NOT NULL,
            created_at      INTEGER NOT NULL,
            enc_key_epoch   INTEGER NOT NULL DEFAULT 0,
            is_archived     INTEGER NOT NULL DEFAULT 0,
            archived_at     INTEGER,
            room_cooldown_secs INTEGER
        );

        CREATE TABLE IF NOT EXISTS events (
            event_id        TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL,
            title           TEXT NOT NULL,
            description     TEXT,
            location_type   TEXT NOT NULL,
            location_text   TEXT,
            location_room_id TEXT,
            start_at        INTEGER NOT NULL,
            end_at          INTEGER,
            created_by      TEXT NOT NULL,
            created_at      INTEGER NOT NULL,
            is_deleted      INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS event_rsvps (
            event_id        TEXT NOT NULL,
            member_key      TEXT NOT NULL,
            status          TEXT NOT NULL,
            updated_at      INTEGER NOT NULL,
            PRIMARY KEY (event_id, member_key)
        );

        CREATE TABLE IF NOT EXISTS org_user_cooldowns (
            org_id          TEXT NOT NULL,
            member_key      TEXT NOT NULL,
            cooldown_secs   INTEGER NOT NULL,
            PRIMARY KEY (org_id, member_key)
        );

        CREATE TABLE IF NOT EXISTS org_ice (
            org_id          TEXT NOT NULL,
            member_key      TEXT NOT NULL,
            iced_until      INTEGER NOT NULL,
            PRIMARY KEY (org_id, member_key)
        );

        CREATE TABLE IF NOT EXISTS messages (
            message_id      TEXT PRIMARY KEY,
            room_id         TEXT,
            dm_thread_id    TEXT,
            author_key      TEXT NOT NULL,
            content_type    TEXT NOT NULL,
            text_content    TEXT,
            blob_id         TEXT,
            embed_url       TEXT,
            mentions        TEXT,
            reply_to        TEXT,
            timestamp       INTEGER NOT NULL,
            edited_at       INTEGER,
            is_deleted      INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS reactions (
            message_id      TEXT NOT NULL,
            emoji           TEXT NOT NULL,
            reactor_key     TEXT NOT NULL,
            PRIMARY KEY (message_id, emoji, reactor_key)
        );

        CREATE TABLE IF NOT EXISTS dm_threads (
            thread_id         TEXT PRIMARY KEY,
            initiator_key     TEXT NOT NULL,
            recipient_key     TEXT NOT NULL,
            created_at        INTEGER NOT NULL,
            last_message_at   INTEGER
        );

        -- Projector bookmark: tracks the last seq_num projected per (log_id, author).
        CREATE TABLE IF NOT EXISTS projector_cursors (
            log_id          TEXT NOT NULL,
            public_key      TEXT NOT NULL,
            last_seq_num    INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (log_id, public_key)
        );

        CREATE TABLE IF NOT EXISTS enc_key_manager (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            state_data  BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS enc_key_registry (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            state_data  BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS enc_group_state (
            group_id    TEXT PRIMARY KEY,
            group_type  TEXT NOT NULL,
            state_data  BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blob_meta (
            blob_hash   TEXT PRIMARY KEY,
            mime_type   TEXT NOT NULL,
            room_id     TEXT,
            sender_key  TEXT,
            secret_id   BLOB,
            nonce       BLOB
        );

        CREATE TABLE IF NOT EXISTS topic_seq (
            topic_hex   TEXT PRIMARY KEY,
            last_seq    INTEGER NOT NULL DEFAULT 0
        );

        -- Member moderation tables
        CREATE TABLE IF NOT EXISTS org_bans (
            org_id          TEXT NOT NULL,
            member_key      TEXT NOT NULL,
            banned_at       INTEGER NOT NULL,
            banned_by       TEXT NOT NULL,
            reason          TEXT,
            PRIMARY KEY (org_id, member_key)
        );

        CREATE TABLE IF NOT EXISTS org_mutes (
            org_id          TEXT NOT NULL,
            member_key      TEXT NOT NULL,
            muted_at        INTEGER NOT NULL,
            muted_by        TEXT NOT NULL,
            expires_at      INTEGER NOT NULL,
            reason          TEXT,
            PRIMARY KEY (org_id, member_key)
        );

        CREATE TABLE IF NOT EXISTS ignored_keys (
            public_key  TEXT PRIMARY KEY,
            ignored_at  INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    // ── Additive migrations (safe to re-run: errors are ignored) ──────────────
    // ALTER TABLE ADD COLUMN fails with "duplicate column name" if already present;
    // that is harmless, so we swallow the error.
    let _ = sqlx::query(
        "ALTER TABLE profiles ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0"
    )
    .execute(pool)
    .await;

    // Add org keypair columns (for org keypair feature)
    let _ = sqlx::query("ALTER TABLE organizations ADD COLUMN org_pubkey TEXT")
        .execute(pool)
        .await;
    let _ = sqlx::query("ALTER TABLE organizations ADD COLUMN org_privkey_enc BLOB")
        .execute(pool)
        .await;

    Ok(())
}

// ─── Encryption state ────────────────────────────────────────────────────────

pub async fn save_enc_key_manager(pool: &SqlitePool, state: &[u8]) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO enc_key_manager (id, state_data) VALUES (1, ?)\n         ON CONFLICT(id) DO UPDATE SET state_data = excluded.state_data",
    )
    .bind(state)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_enc_key_manager(pool: &SqlitePool) -> Result<Option<Vec<u8>>, DbError> {
    let row = sqlx::query("SELECT state_data FROM enc_key_manager WHERE id = 1")
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<Vec<u8>, _>("state_data")))
}

pub async fn save_enc_key_registry(pool: &SqlitePool, state: &[u8]) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO enc_key_registry (id, state_data) VALUES (1, ?)\n         ON CONFLICT(id) DO UPDATE SET state_data = excluded.state_data",
    )
    .bind(state)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_enc_key_registry(pool: &SqlitePool) -> Result<Option<Vec<u8>>, DbError> {
    let row = sqlx::query("SELECT state_data FROM enc_key_registry WHERE id = 1")
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<Vec<u8>, _>("state_data")))
}

pub async fn save_enc_group_state(
    pool: &SqlitePool,
    group_id: &str,
    group_type: &str,
    state: &[u8],
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO enc_group_state (group_id, group_type, state_data) VALUES (?, ?, ?)\n         ON CONFLICT(group_id) DO UPDATE SET state_data = excluded.state_data",
    )
    .bind(group_id)
    .bind(group_type)
    .bind(state)
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns Vec of (group_id, group_type, state_data).
pub async fn load_all_enc_group_states(
    pool: &SqlitePool,
) -> Result<Vec<(String, String, Vec<u8>)>, DbError> {
    let rows = sqlx::query("SELECT group_id, group_type, state_data FROM enc_group_state")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get("group_id"), r.get("group_type"), r.get("state_data")))
        .collect())
}

pub async fn load_enc_group_state(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<Option<Vec<u8>>, DbError> {
    let row = sqlx::query(
        "SELECT state_data FROM enc_group_state WHERE group_id = ?"
    )
    .bind(group_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.get::<Vec<u8>, _>("state_data")))
}

// ─── Row types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProfileRow {
    pub public_key: String,
    pub username: String,
    pub avatar_blob_id: Option<String>,
    pub bio: Option<String>,
    pub available_for: String, // stored as JSON
    pub created_at: i64,
    pub updated_at: i64,
    pub is_public: Option<i64>,
    pub email_enabled: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrgRow {
    pub org_id: String,
    pub name: String,
    pub type_label: String,
    pub description: Option<String>,
    pub avatar_blob_id: Option<String>,
    pub cover_blob_id: Option<String>,
    pub welcome_text: Option<String>,
    pub custom_emoji_json: Option<String>,
    pub org_cooldown_secs: Option<i64>,
    pub is_public: i64,
    pub creator_key: String,
    pub org_pubkey: Option<String>,      // Z32-encoded public key
    pub org_privkey_enc: Option<Vec<u8>>, // Encrypted private key
    pub created_at: i64,
    pub email_enabled: i64,
}

#[derive(Debug, Clone)]
pub struct RoomRow {
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

pub struct EventRow {
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

pub struct EventRsvpRow {
    pub event_id: String,
    pub member_key: String,
    pub status: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct MessageRow {
    pub message_id: String,
    pub room_id: Option<String>,
    pub dm_thread_id: Option<String>,
    pub author_key: String,
    pub content_type: String,
    pub text_content: Option<String>,
    pub blob_id: Option<String>,
    pub embed_url: Option<String>,
    pub mentions: Vec<String>, // JSON
    pub reply_to: Option<String>,
    pub timestamp: i64,
    pub edited_at: Option<i64>,
    pub is_deleted: bool,
}

#[derive(Debug, Clone)]
pub struct DmThreadRow {
    pub thread_id: String,
    pub initiator_key: String,
    pub recipient_key: String,
    pub created_at: i64,
    pub last_message_at: Option<i64>,
    pub is_request: bool,
}

#[derive(Debug, Clone)]
pub struct BlobMeta {
    pub blob_hash: String,
    pub mime_type: String,
    pub room_id: Option<String>,
    pub sender_key: Option<String>,  // hex
    pub secret_id: Option<Vec<u8>>,  // [u8; 32] GroupSecretId
    pub nonce: Option<Vec<u8>>,      // [u8; 24] XAeadNonce
}

// ─── Profile ─────────────────────────────────────────────────────────────────

pub async fn upsert_profile(pool: &SqlitePool, row: &ProfileRow) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO profiles (public_key, username, avatar_blob_id, bio, available_for, is_public, created_at, updated_at, email_enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(public_key) DO UPDATE SET
               username = excluded.username,
               avatar_blob_id = excluded.avatar_blob_id,
               bio = excluded.bio,
               available_for = excluded.available_for,
               is_public = excluded.is_public,
               updated_at = excluded.updated_at,
               email_enabled = excluded.email_enabled"#,
    )
    .bind(&row.public_key)
    .bind(&row.username)
    .bind(&row.avatar_blob_id)
    .bind(&row.bio)
    .bind(&row.available_for)
    .bind(row.is_public)
    .bind(row.created_at)
    .bind(row.updated_at)
    .bind(row.email_enabled)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_profile(pool: &SqlitePool, public_key: &str) -> Result<Option<ProfileRow>, DbError> {
    let row = sqlx::query_as::<_, ProfileRow>(
        "SELECT * FROM profiles WHERE public_key = ?"
    )
    .bind(public_key)
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

// ─── Organization ────────────────────────────────────────────────────────────

pub async fn insert_org(pool: &SqlitePool, row: &OrgRow) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO organizations (org_id, name, type_label, description, avatar_blob_id, cover_blob_id, welcome_text, custom_emoji_json, org_cooldown_secs, is_public, creator_key, org_pubkey, org_privkey_enc, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id) DO UPDATE SET
               -- Preserve existing org fields; only fill in keys if they were missing.
               org_pubkey = COALESCE(organizations.org_pubkey, excluded.org_pubkey),
               org_privkey_enc = COALESCE(organizations.org_privkey_enc, excluded.org_privkey_enc)"#,
    )
    .bind(&row.org_id)
    .bind(&row.name)
    .bind(&row.type_label)
    .bind(&row.description)
    .bind(&row.avatar_blob_id)
    .bind(&row.cover_blob_id)
    .bind(&row.welcome_text)
    .bind(&row.custom_emoji_json)
    .bind(&row.org_cooldown_secs)
    .bind(row.is_public as i64)
    .bind(&row.creator_key)
    .bind(&row.org_pubkey)
    .bind(&row.org_privkey_enc)
    .bind(row.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_org(
    pool: &SqlitePool,
    org_id: &str,
    name: Option<&str>,
    type_label: Option<&str>,
    description: Option<&str>,
    avatar_blob_id: Option<&str>,
    cover_blob_id: Option<&str>,
    welcome_text: Option<&str>,
    custom_emoji_json: Option<&str>,
    org_cooldown_secs: Option<i64>,
    is_public: Option<bool>,
    email_enabled: Option<bool>,
) -> Result<(), DbError> {
    let mut query_parts = vec![];

    if name.is_some() {
        query_parts.push("name = ?");
    }
    if type_label.is_some() {
        query_parts.push("type_label = ?");
    }
    if description.is_some() {
        query_parts.push("description = ?");
    }
    if avatar_blob_id.is_some() {
        query_parts.push("avatar_blob_id = ?");
    }
    if cover_blob_id.is_some() {
        query_parts.push("cover_blob_id = ?");
    }
    if welcome_text.is_some() {
        query_parts.push("welcome_text = ?");
    }
    if custom_emoji_json.is_some() {
        query_parts.push("custom_emoji_json = ?");
    }
    if org_cooldown_secs.is_some() {
        query_parts.push("org_cooldown_secs = ?");
    }
    if is_public.is_some() {
        query_parts.push("is_public = ?");
    }
    if email_enabled.is_some() {
        query_parts.push("email_enabled = ?");
    }

    if query_parts.is_empty() {
        return Ok(());
    }

    let query = format!("UPDATE organizations SET {} WHERE org_id = ?", query_parts.join(", "));

    let mut q = sqlx::query(&query);

    if let Some(name) = name {
        q = q.bind(name);
    }
    if let Some(type_label) = type_label {
        q = q.bind(type_label);
    }
    if let Some(description) = description {
        q = q.bind(description);
    }
    if let Some(avatar_blob_id) = avatar_blob_id {
        q = q.bind(avatar_blob_id);
    }
    if let Some(cover_blob_id) = cover_blob_id {
        q = q.bind(cover_blob_id);
    }
    if let Some(welcome_text) = welcome_text {
        q = q.bind(welcome_text);
    }
    if let Some(custom_emoji_json) = custom_emoji_json {
        q = q.bind(custom_emoji_json);
    }
    if let Some(org_cooldown_secs) = org_cooldown_secs {
        q = q.bind(org_cooldown_secs);
    }
    if let Some(is_public) = is_public {
        q = q.bind(is_public as i64);
    }
    if let Some(email_enabled) = email_enabled {
        q = q.bind(email_enabled as i64);
    }

    q.bind(org_id).execute(pool).await?;
    Ok(())
}

pub async fn set_org_pubkey(
    pool: &SqlitePool,
    org_id: &str,
    org_pubkey: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE organizations SET org_pubkey = ? WHERE org_id = ?")
        .bind(org_pubkey)
        .bind(org_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_room(
    pool: &SqlitePool,
    room_id: &str,
    name: Option<&str>,
    room_cooldown_secs: Option<i64>,
) -> Result<(), DbError> {
    let mut parts = vec![];
    if name.is_some() {
        parts.push("name = ?");
    }
    if room_cooldown_secs.is_some() {
        parts.push("room_cooldown_secs = ?");
    }
    if parts.is_empty() {
        return Ok(());
    }
    let query = format!("UPDATE rooms SET {} WHERE room_id = ?", parts.join(", "));
    let mut q = sqlx::query(&query);
    if let Some(name) = name {
        q = q.bind(name);
    }
    if let Some(room_cooldown_secs) = room_cooldown_secs {
        q = q.bind(room_cooldown_secs);
    }
    q.bind(room_id).execute(pool).await?;
    Ok(())
}

pub async fn get_org(pool: &SqlitePool, org_id: &str) -> Result<Option<OrgRow>, DbError> {
    let row = sqlx::query(
        "SELECT org_id, name, type_label, description, avatar_blob_id, cover_blob_id, welcome_text, custom_emoji_json, org_cooldown_secs, \
         is_public, creator_key, org_pubkey, org_privkey_enc, created_at, email_enabled \
         FROM organizations WHERE org_id = ?"
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| OrgRow {
        org_id: r.get("org_id"),
        name: r.get("name"),
        type_label: r.get("type_label"),
        description: r.get("description"),
        avatar_blob_id: r.get("avatar_blob_id"),
        cover_blob_id: r.get("cover_blob_id"),
        welcome_text: r.get("welcome_text"),
        custom_emoji_json: r.get("custom_emoji_json"),
        org_cooldown_secs: r.get("org_cooldown_secs"),
        is_public: r.get::<i64, _>("is_public"),
        creator_key: r.get("creator_key"),
        org_pubkey: r.get("org_pubkey"),
        org_privkey_enc: r.get("org_privkey_enc"),
        created_at: r.get("created_at"),
        email_enabled: r.get::<i64, _>("email_enabled"),
    }))
}

pub async fn list_orgs_for_member(pool: &SqlitePool, member_key: &str) -> Result<Vec<OrgRow>, DbError> {
    let rows = sqlx::query(
        r#"SELECT o.org_id, o.name, o.type_label, o.description, o.avatar_blob_id, o.cover_blob_id,
                  o.welcome_text, o.custom_emoji_json, o.org_cooldown_secs, o.is_public, o.creator_key, o.org_pubkey, o.org_privkey_enc, o.created_at, o.email_enabled
           FROM organizations o
           JOIN memberships m ON m.org_id = o.org_id
           WHERE m.member_key = ?
           ORDER BY o.created_at DESC"#,
    )
    .bind(member_key)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| OrgRow {
            org_id: r.get("org_id"),
            name: r.get("name"),
            type_label: r.get("type_label"),
            description: r.get("description"),
            avatar_blob_id: r.get("avatar_blob_id"),
            cover_blob_id: r.get("cover_blob_id"),
            welcome_text: r.get("welcome_text"),
            custom_emoji_json: r.get("custom_emoji_json"),
            org_cooldown_secs: r.get("org_cooldown_secs"),
            is_public: r.get::<i64, _>("is_public"),
            creator_key: r.get("creator_key"),
            org_pubkey: r.get("org_pubkey"),
            org_privkey_enc: r.get("org_privkey_enc"),
            created_at: r.get("created_at"),
            email_enabled: r.get::<i64, _>("email_enabled"),
        })
        .collect())
}

// ─── Membership ──────────────────────────────────────────────────────────────

pub async fn upsert_membership(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
    access_level: &str,
    joined_at: i64,
) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO memberships (org_id, member_key, access_level, joined_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(org_id, member_key) DO UPDATE SET access_level = excluded.access_level"#,
    )
    .bind(org_id)
    .bind(member_key)
    .bind(access_level)
    .bind(joined_at)
    .execute(pool)
    .await?;
    Ok(())
}

// ─── Moderation ──────────────────────────────────────────────────────────────

pub async fn ban_member(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
    banned_by: &str,
    banned_at: i64,
    reason: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO org_bans (org_id, member_key, banned_at, banned_by, reason)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(org_id, member_key) DO UPDATE SET
               banned_at = excluded.banned_at,
               banned_by = excluded.banned_by,
               reason = excluded.reason"#,
    )
    .bind(org_id)
    .bind(member_key)
    .bind(banned_at)
    .bind(banned_by)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn unban_member(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM org_bans WHERE org_id = ? AND member_key = ?")
        .bind(org_id)
        .bind(member_key)
        .execute(pool)
        .await?;
    Ok(())
}

/// Increment enc_key_epoch for all rooms in an org.
/// Called after a ban to force key rotation for subsequent messages.
pub async fn bump_room_epochs_for_org(pool: &SqlitePool, org_id: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE rooms SET enc_key_epoch = enc_key_epoch + 1 WHERE org_id = ?")
        .bind(org_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn is_banned(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
) -> Result<bool, DbError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM org_bans WHERE org_id = ? AND member_key = ?"
    )
    .bind(org_id)
    .bind(member_key)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

pub async fn mute_member(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
    muted_by: &str,
    muted_at: i64,
    expires_at: i64,
    reason: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO org_mutes (org_id, member_key, muted_at, muted_by, expires_at, reason)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id, member_key) DO UPDATE SET
               muted_at = excluded.muted_at,
               muted_by = excluded.muted_by,
               expires_at = excluded.expires_at,
               reason = excluded.reason"#,
    )
    .bind(org_id)
    .bind(member_key)
    .bind(muted_at)
    .bind(muted_by)
    .bind(expires_at)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn unmute_member(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM org_mutes WHERE org_id = ? AND member_key = ?")
        .bind(org_id)
        .bind(member_key)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn is_muted(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
    now: i64,
) -> Result<bool, DbError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM org_mutes WHERE org_id = ? AND member_key = ? AND expires_at > ?"
    )
    .bind(org_id)
    .bind(member_key)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

// ─── Ignore (client-side user ignore list) ───────────────────────────────────

pub async fn ignore_user(pool: &SqlitePool, public_key: &str, now: i64) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO ignored_keys (public_key, ignored_at) VALUES (?, ?) ON CONFLICT(public_key) DO NOTHING"
    )
    .bind(public_key)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn unignore_user(pool: &SqlitePool, public_key: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM ignored_keys WHERE public_key = ?")
        .bind(public_key)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_ignored_users(pool: &SqlitePool) -> Result<Vec<String>, DbError> {
    let rows = sqlx::query("SELECT public_key FROM ignored_keys ORDER BY ignored_at DESC")
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(|r| r.get::<String, _>("public_key")).collect())
}

pub async fn is_ignored(pool: &SqlitePool, public_key: &str) -> Result<bool, DbError> {
    let row = sqlx::query("SELECT 1 FROM ignored_keys WHERE public_key = ? LIMIT 1")
        .bind(public_key)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

// ─── Room ────────────────────────────────────────────────────────────────────

pub async fn insert_room(pool: &SqlitePool, row: &RoomRow) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO rooms (room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at, room_cooldown_secs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id) DO UPDATE SET 
               name = excluded.name,
               enc_key_epoch = excluded.enc_key_epoch,
               is_archived = excluded.is_archived,
               archived_at = excluded.archived_at,
               room_cooldown_secs = excluded.room_cooldown_secs"#,
    )
    .bind(&row.room_id)
    .bind(&row.org_id)
    .bind(&row.name)
    .bind(&row.created_by)
    .bind(row.created_at)
    .bind(row.enc_key_epoch as i64)
    .bind(row.is_archived as i64)
    .bind(row.archived_at)
    .bind(row.room_cooldown_secs)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_room(pool: &SqlitePool, room_id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM rooms WHERE room_id = ?")
        .bind(room_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn archive_room(pool: &SqlitePool, room_id: &str, archived_at: i64) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE rooms SET is_archived = 1, archived_at = ? WHERE room_id = ?"
    )
    .bind(archived_at)
    .bind(room_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn unarchive_room(pool: &SqlitePool, room_id: &str) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE rooms SET is_archived = 0, archived_at = NULL WHERE room_id = ?"
    )
    .bind(room_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_room(pool: &SqlitePool, room_id: &str) -> Result<Option<RoomRow>, DbError> {
    let row = sqlx::query(
        "SELECT room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at, room_cooldown_secs FROM rooms WHERE room_id = ?"
    )
    .bind(room_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| RoomRow {
        room_id: r.get("room_id"),
        org_id: r.get("org_id"),
        name: r.get("name"),
        created_by: r.get("created_by"),
        created_at: r.get("created_at"),
        enc_key_epoch: r.get::<i64, _>("enc_key_epoch") as u64,
        is_archived: r.get::<i64, _>("is_archived") != 0,
        archived_at: r.get("archived_at"),
        room_cooldown_secs: r.get("room_cooldown_secs"),
    }))
}

pub async fn list_rooms(pool: &SqlitePool, org_id: &str, include_archived: bool) -> Result<Vec<RoomRow>, DbError> {
    let query = if include_archived {
        "SELECT room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at, room_cooldown_secs FROM rooms WHERE org_id = ? ORDER BY created_at ASC"
    } else {
        "SELECT room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at, room_cooldown_secs FROM rooms WHERE org_id = ? AND is_archived = 0 ORDER BY created_at ASC"
    };

    let rows = sqlx::query(query)
        .bind(org_id)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|r| RoomRow {
            room_id: r.get("room_id"),
            org_id: r.get("org_id"),
            name: r.get("name"),
            created_by: r.get("created_by"),
            created_at: r.get("created_at"),
            enc_key_epoch: r.get::<i64, _>("enc_key_epoch") as u64,
            is_archived: r.get::<i64, _>("is_archived") != 0,
            archived_at: r.get("archived_at"),
            room_cooldown_secs: r.get("room_cooldown_secs"),
        })
        .collect())
}

// ─── Events ──────────────────────────────────────────────────────────────────

pub async fn insert_event(pool: &SqlitePool, row: &EventRow) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO events (event_id, org_id, title, description, location_type, location_text, location_room_id, start_at, end_at, created_by, created_at, is_deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
               title = excluded.title,
               description = excluded.description,
               location_type = excluded.location_type,
               location_text = excluded.location_text,
               location_room_id = excluded.location_room_id,
               start_at = excluded.start_at,
               end_at = excluded.end_at,
               is_deleted = excluded.is_deleted"#,
    )
    .bind(&row.event_id)
    .bind(&row.org_id)
    .bind(&row.title)
    .bind(&row.description)
    .bind(&row.location_type)
    .bind(&row.location_text)
    .bind(&row.location_room_id)
    .bind(row.start_at)
    .bind(row.end_at)
    .bind(&row.created_by)
    .bind(row.created_at)
    .bind(row.is_deleted as i64)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_event(
    pool: &SqlitePool,
    event_id: &str,
    title: Option<&str>,
    description: Option<&str>,
    location_type: Option<&str>,
    location_text: Option<&str>,
    location_room_id: Option<&str>,
    start_at: Option<i64>,
    end_at: Option<i64>,
) -> Result<(), DbError> {
    let mut parts = vec![];
    if title.is_some() { parts.push("title = ?"); }
    if description.is_some() { parts.push("description = ?"); }
    if location_type.is_some() { parts.push("location_type = ?"); }
    if location_text.is_some() { parts.push("location_text = ?"); }
    if location_room_id.is_some() { parts.push("location_room_id = ?"); }
    if start_at.is_some() { parts.push("start_at = ?"); }
    if end_at.is_some() { parts.push("end_at = ?"); }
    if parts.is_empty() { return Ok(()); }

    let query = format!("UPDATE events SET {} WHERE event_id = ?", parts.join(", "));
    let mut q = sqlx::query(&query);
    if let Some(v) = title { q = q.bind(v); }
    if let Some(v) = description { q = q.bind(v); }
    if let Some(v) = location_type { q = q.bind(v); }
    if let Some(v) = location_text { q = q.bind(v); }
    if let Some(v) = location_room_id { q = q.bind(v); }
    if let Some(v) = start_at { q = q.bind(v); }
    if let Some(v) = end_at { q = q.bind(v); }
    q.bind(event_id).execute(pool).await?;
    Ok(())
}

pub async fn delete_event(pool: &SqlitePool, event_id: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE events SET is_deleted = 1 WHERE event_id = ?")
        .bind(event_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_events(pool: &SqlitePool, org_id: &str) -> Result<Vec<EventRow>, DbError> {
    let rows = sqlx::query(
        "SELECT event_id, org_id, title, description, location_type, location_text, location_room_id, start_at, end_at, created_by, created_at, is_deleted FROM events WHERE org_id = ? AND is_deleted = 0 ORDER BY start_at ASC"
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| EventRow {
        event_id: r.get("event_id"),
        org_id: r.get("org_id"),
        title: r.get("title"),
        description: r.get("description"),
        location_type: r.get("location_type"),
        location_text: r.get("location_text"),
        location_room_id: r.get("location_room_id"),
        start_at: r.get("start_at"),
        end_at: r.get("end_at"),
        created_by: r.get("created_by"),
        created_at: r.get("created_at"),
        is_deleted: r.get::<i64, _>("is_deleted") != 0,
    }).collect())
}

pub async fn upsert_event_rsvp(
    pool: &SqlitePool,
    event_id: &str,
    member_key: &str,
    status: &str,
    updated_at: i64,
) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO event_rsvps (event_id, member_key, status, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id, member_key) DO UPDATE SET
               status = excluded.status,
               updated_at = excluded.updated_at"#,
    )
    .bind(event_id)
    .bind(member_key)
    .bind(status)
    .bind(updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_event_rsvp(
    pool: &SqlitePool,
    event_id: &str,
    member_key: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM event_rsvps WHERE event_id = ? AND member_key = ?")
        .bind(event_id)
        .bind(member_key)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_event_rsvps(pool: &SqlitePool, event_id: &str) -> Result<Vec<EventRsvpRow>, DbError> {
    let rows = sqlx::query(
        "SELECT event_id, member_key, status, updated_at FROM event_rsvps WHERE event_id = ?"
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| EventRsvpRow {
        event_id: r.get("event_id"),
        member_key: r.get("member_key"),
        status: r.get("status"),
        updated_at: r.get("updated_at"),
    }).collect())
}

// ─── Message ─────────────────────────────────────────────────────────────────

pub async fn insert_message(pool: &SqlitePool, row: &MessageRow) -> Result<(), DbError> {
    let mentions_json = serde_json::to_string(&row.mentions).unwrap_or_default();
    sqlx::query(
        r#"INSERT INTO messages
               (message_id, room_id, dm_thread_id, author_key, content_type,
                text_content, blob_id, embed_url, mentions, reply_to, timestamp, is_deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET
               text_content = excluded.text_content,
               edited_at    = strftime('%s', 'now') * 1000000,
               is_deleted   = excluded.is_deleted"#,
    )
    .bind(&row.message_id)
    .bind(&row.room_id)
    .bind(&row.dm_thread_id)
    .bind(&row.author_key)
    .bind(&row.content_type)
    .bind(&row.text_content)
    .bind(&row.blob_id)
    .bind(&row.embed_url)
    .bind(&mentions_json)
    .bind(&row.reply_to)
    .bind(row.timestamp)
    .bind(row.is_deleted as i64)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_messages(
    pool: &SqlitePool,
    room_id: Option<&str>,
    dm_thread_id: Option<&str>,
    limit: u32,
    before_timestamp: Option<i64>,
) -> Result<Vec<MessageRow>, DbError> {
    // Build query dynamically based on context.
    let rows = match (room_id, dm_thread_id, before_timestamp) {
        (Some(rid), _, Some(before)) => {
            sqlx::query(
                "SELECT * FROM messages WHERE room_id = ? AND timestamp < ? AND is_deleted = 0 AND author_key NOT IN (SELECT public_key FROM ignored_keys) ORDER BY timestamp DESC LIMIT ?"
            )
            .bind(rid).bind(before).bind(limit as i64)
            .fetch_all(pool).await?
        }
        (Some(rid), _, None) => {
            sqlx::query(
                "SELECT * FROM messages WHERE room_id = ? AND is_deleted = 0 AND author_key NOT IN (SELECT public_key FROM ignored_keys) ORDER BY timestamp DESC LIMIT ?"
            )
            .bind(rid).bind(limit as i64)
            .fetch_all(pool).await?
        }
        (_, Some(tid), Some(before)) => {
            sqlx::query(
                "SELECT * FROM messages WHERE dm_thread_id = ? AND timestamp < ? AND is_deleted = 0 AND author_key NOT IN (SELECT public_key FROM ignored_keys) ORDER BY timestamp DESC LIMIT ?"
            )
            .bind(tid).bind(before).bind(limit as i64)
            .fetch_all(pool).await?
        }
        (_, Some(tid), None) => {
            sqlx::query(
                "SELECT * FROM messages WHERE dm_thread_id = ? AND is_deleted = 0 AND author_key NOT IN (SELECT public_key FROM ignored_keys) ORDER BY timestamp DESC LIMIT ?"
            )
            .bind(tid).bind(limit as i64)
            .fetch_all(pool).await?
        }
        _ => return Ok(vec![]),
    };

    Ok(rows
        .into_iter()
        .map(|r| {
            let mentions_json: String = r.try_get("mentions").unwrap_or_default();
            MessageRow {
                message_id: r.get("message_id"),
                room_id: r.get("room_id"),
                dm_thread_id: r.get("dm_thread_id"),
                author_key: r.get("author_key"),
                content_type: r.get("content_type"),
                text_content: r.get("text_content"),
                blob_id: r.get("blob_id"),
                embed_url: r.get("embed_url"),
                mentions: serde_json::from_str(&mentions_json).unwrap_or_default(),
                reply_to: r.get("reply_to"),
                timestamp: r.get("timestamp"),
                edited_at: r.get("edited_at"),
                is_deleted: r.get::<i64, _>("is_deleted") != 0,
            }
        })
        .collect())
}

// ─── Reaction ────────────────────────────────────────────────────────────────

pub async fn upsert_reaction(
    pool: &SqlitePool,
    message_id: &str,
    emoji: &str,
    reactor_key: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT OR IGNORE INTO reactions (message_id, emoji, reactor_key) VALUES (?, ?, ?)",
    )
    .bind(message_id)
    .bind(emoji)
    .bind(reactor_key)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_reaction(
    pool: &SqlitePool,
    message_id: &str,
    emoji: &str,
    reactor_key: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND reactor_key = ?")
        .bind(message_id)
        .bind(emoji)
        .bind(reactor_key)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── DM thread ───────────────────────────────────────────────────────────────

pub async fn insert_dm_thread(pool: &SqlitePool, row: &DmThreadRow) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO dm_threads (thread_id, initiator_key, recipient_key, created_at, last_message_at, is_request)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET last_message_at = excluded.last_message_at"#,
    )
    .bind(&row.thread_id)
    .bind(&row.initiator_key)
    .bind(&row.recipient_key)
    .bind(row.created_at)
    .bind(row.last_message_at)
    .bind(if row.is_request { 1i64 } else { 0i64 })
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_reactions(
    pool: &SqlitePool,
    message_ids: &[String],
) -> Result<Vec<crate::Reaction>, DbError> {
    if message_ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = vec!["?"; message_ids.len()].join(", ");
    let query = format!(
        "SELECT message_id, emoji, reactor_key FROM reactions WHERE message_id IN ({})",
        placeholders
    );
    let mut q = sqlx::query(&query);
    for id in message_ids {
        q = q.bind(id);
    }
    let rows = q.fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|r| crate::Reaction {
            message_id: r.get("message_id"),
            emoji: r.get("emoji"),
            reactor_key: r.get("reactor_key"),
        })
        .collect())
}

// ─── Cooldowns & Ice ─────────────────────────────────────────────────────────

pub async fn set_org_user_cooldown(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
    cooldown_secs: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO org_user_cooldowns (org_id, member_key, cooldown_secs) VALUES (?, ?, ?)
         ON CONFLICT(org_id, member_key) DO UPDATE SET cooldown_secs = excluded.cooldown_secs",
    )
    .bind(org_id)
    .bind(member_key)
    .bind(cooldown_secs)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_org_user_cooldown(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
) -> Result<Option<i64>, DbError> {
    let row = sqlx::query("SELECT cooldown_secs FROM org_user_cooldowns WHERE org_id = ? AND member_key = ?")
        .bind(org_id)
        .bind(member_key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<i64, _>("cooldown_secs")))
}

pub async fn set_ice(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
    iced_until: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO org_ice (org_id, member_key, iced_until) VALUES (?, ?, ?)
         ON CONFLICT(org_id, member_key) DO UPDATE SET iced_until = excluded.iced_until",
    )
    .bind(org_id)
    .bind(member_key)
    .bind(iced_until)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_ice(pool: &SqlitePool, org_id: &str, member_key: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM org_ice WHERE org_id = ? AND member_key = ?")
        .bind(org_id)
        .bind(member_key)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_ice(pool: &SqlitePool, org_id: &str) -> Result<Vec<(String, i64)>, DbError> {
    let rows = sqlx::query("SELECT member_key, iced_until FROM org_ice WHERE org_id = ?")
        .bind(org_id)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get("member_key"), r.get::<i64, _>("iced_until")))
        .collect())
}

pub async fn get_ice_for_member(
    pool: &SqlitePool,
    org_id: &str,
    member_key: &str,
) -> Result<Option<i64>, DbError> {
    let row = sqlx::query("SELECT iced_until FROM org_ice WHERE org_id = ? AND member_key = ?")
        .bind(org_id)
        .bind(member_key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<i64, _>("iced_until")))
}

pub async fn last_message_in_room_by_author(
    pool: &SqlitePool,
    room_id: &str,
    author_key: &str,
) -> Result<Option<i64>, DbError> {
    let row = sqlx::query("SELECT timestamp FROM messages WHERE room_id = ? AND author_key = ? ORDER BY timestamp DESC LIMIT 1")
        .bind(room_id)
        .bind(author_key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<i64, _>("timestamp")))
}

pub async fn last_message_in_org_by_author(
    pool: &SqlitePool,
    org_id: &str,
    author_key: &str,
) -> Result<Option<i64>, DbError> {
    let row = sqlx::query(
        "SELECT m.timestamp FROM messages m
         JOIN rooms r ON r.room_id = m.room_id
         WHERE r.org_id = ? AND m.author_key = ?
         ORDER BY m.timestamp DESC LIMIT 1"
    )
    .bind(org_id)
    .bind(author_key)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.get::<i64, _>("timestamp")))
}

pub async fn list_dm_threads(pool: &SqlitePool, my_key: &str) -> Result<Vec<DmThreadRow>, DbError> {
    let rows = sqlx::query(
        r#"SELECT thread_id, initiator_key, recipient_key, created_at, last_message_at, is_request
           FROM dm_threads
           WHERE initiator_key = ? OR recipient_key = ?
           ORDER BY COALESCE(last_message_at, created_at) DESC"#,
    )
    .bind(my_key)
    .bind(my_key)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| DmThreadRow {
            thread_id: r.get("thread_id"),
            initiator_key: r.get("initiator_key"),
            recipient_key: r.get("recipient_key"),
            created_at: r.get("created_at"),
            last_message_at: r.get("last_message_at"),
            is_request: r.get::<i64, _>("is_request") != 0,
        })
        .collect())
}

/// Returns true if `initiator_key` has a prior relationship with `local_key`:
/// an existing DM thread, or shared org membership.
pub async fn is_known_sender(pool: &SqlitePool, initiator_key: &str, local_key: &str) -> Result<bool, DbError> {
    // Check for existing DM thread
    let existing = sqlx::query(
        "SELECT 1 FROM dm_threads WHERE (initiator_key = ? AND recipient_key = ?) OR (initiator_key = ? AND recipient_key = ?) LIMIT 1"
    )
    .bind(initiator_key).bind(local_key)
    .bind(local_key).bind(initiator_key)
    .fetch_optional(pool)
    .await?;
    if existing.is_some() {
        return Ok(true);
    }
    // Check for shared org membership
    let shared_org = sqlx::query(
        "SELECT 1 FROM memberships m1 JOIN memberships m2 ON m1.org_id = m2.org_id WHERE m1.member_key = ? AND m2.member_key = ? LIMIT 1"
    )
    .bind(initiator_key).bind(local_key)
    .fetch_optional(pool)
    .await?;
    Ok(shared_org.is_some())
}

// ─── Blob meta ───────────────────────────────────────────────────────────────

pub async fn insert_blob_meta(pool: &SqlitePool, meta: &BlobMeta) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO blob_meta (blob_hash, mime_type, room_id, sender_key, secret_id, nonce)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(blob_hash) DO UPDATE SET
             mime_type  = excluded.mime_type,
             room_id    = excluded.room_id,
             sender_key = excluded.sender_key,
             secret_id  = excluded.secret_id,
             nonce      = excluded.nonce",
    )
    .bind(&meta.blob_hash)
    .bind(&meta.mime_type)
    .bind(&meta.room_id)
    .bind(&meta.sender_key)
    .bind(&meta.secret_id)
    .bind(&meta.nonce)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_blob_meta(
    pool: &SqlitePool,
    hash: &str,
) -> Result<Option<BlobMeta>, DbError> {
    let row = sqlx::query(
        "SELECT blob_hash, mime_type, room_id, sender_key, secret_id, nonce
         FROM blob_meta WHERE blob_hash = ?",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else { return Ok(None) };

    Ok(Some(BlobMeta {
        blob_hash: row.try_get("blob_hash")?,
        mime_type: row.try_get("mime_type")?,
        room_id: row.try_get("room_id")?,
        sender_key: row.try_get("sender_key")?,
        secret_id: row.try_get("secret_id")?,
        nonce: row.try_get("nonce")?,
    }))
}

// ─── Projector cursor ────────────────────────────────────────────────────────

pub async fn get_cursor(
    pool: &SqlitePool,
    log_id: &str,
    public_key: &str,
) -> Result<u64, DbError> {
    let row = sqlx::query(
        "SELECT last_seq_num FROM projector_cursors WHERE log_id = ? AND public_key = ?",
    )
    .bind(log_id)
    .bind(public_key)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.get::<i64, _>("last_seq_num") as u64).unwrap_or(0))
}

pub async fn set_cursor(
    pool: &SqlitePool,
    log_id: &str,
    public_key: &str,
    seq_num: u64,
) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO projector_cursors (log_id, public_key, last_seq_num)
           VALUES (?, ?, ?)
           ON CONFLICT(log_id, public_key) DO UPDATE SET last_seq_num = excluded.last_seq_num"#,
    )
    .bind(log_id)
    .bind(public_key)
    .bind(seq_num as i64)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_dm_thread(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Option<DmThreadRow>, DbError> {
    let row = sqlx::query(
        r#"SELECT thread_id, initiator_key, recipient_key, created_at, last_message_at, is_request
           FROM dm_threads WHERE thread_id = ?"#,
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await?
    .map(|r| DmThreadRow {
        thread_id: r.get("thread_id"),
        initiator_key: r.get("initiator_key"),
        recipient_key: r.get("recipient_key"),
        created_at: r.get("created_at"),
        last_message_at: r.get("last_message_at"),
        is_request: r.get::<i64, _>("is_request") != 0,
    });
    Ok(row)
}

// ─── Topic seq ───────────────────────────────────────────────────────────────

pub async fn get_topic_seq(pool: &SqlitePool, topic_hex: &str) -> Result<i64, sqlx::Error> {
    let row = sqlx::query_scalar::<_, i64>(
        "SELECT last_seq FROM topic_seq WHERE topic_hex = ?",
    )
    .bind(topic_hex)
    .fetch_optional(pool)
    .await?;
    Ok(row.unwrap_or(0))
}

pub async fn set_topic_seq(pool: &SqlitePool, topic_hex: &str, seq: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO topic_seq (topic_hex, last_seq) VALUES (?, ?)
         ON CONFLICT(topic_hex) DO UPDATE SET last_seq = excluded.last_seq",
    )
    .bind(topic_hex)
    .bind(seq)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod enc_db_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        run_migrations(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn save_and_load_enc_key_manager() {
        let pool = test_pool().await;
        save_enc_key_manager(&pool, b"state_bytes").await.unwrap();
        let loaded = load_enc_key_manager(&pool).await.unwrap();
        assert_eq!(loaded, Some(b"state_bytes".to_vec()));
    }

    #[tokio::test]
    async fn save_and_load_enc_group_state() {
        let pool = test_pool().await;
        save_enc_group_state(&pool, "room1", "room", b"state").await.unwrap();
        let rows = load_all_enc_group_states(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "room1");
        assert_eq!(rows[0].1, "room");
        assert_eq!(rows[0].2, b"state".to_vec());
    }

    #[tokio::test]
    async fn save_and_load_enc_key_registry() {
        let pool = test_pool().await;
        save_enc_key_registry(&pool, b"registry_bytes").await.unwrap();
        let loaded = load_enc_key_registry(&pool).await.unwrap();
        assert_eq!(loaded, Some(b"registry_bytes".to_vec()));
    }

    #[tokio::test]
    async fn blob_meta_insert_and_get() {
        let pool = test_pool().await;

        let meta = BlobMeta {
            blob_hash: "abc123".to_string(),
            mime_type: "image/jpeg".to_string(),
            room_id: Some("room1".to_string()),
            sender_key: Some("deadbeef".to_string()),
            secret_id: Some(vec![1u8; 32]),
            nonce: Some(vec![2u8; 24]),
        };
        insert_blob_meta(&pool, &meta).await.unwrap();

        let got = get_blob_meta(&pool, "abc123").await.unwrap().expect("row must exist");
        assert_eq!(got.blob_hash, "abc123");
        assert_eq!(got.mime_type, "image/jpeg");
        assert_eq!(got.room_id.as_deref(), Some("room1"));
        assert_eq!(got.sender_key.as_deref(), Some("deadbeef"));
        assert_eq!(got.secret_id.as_deref(), Some(&[1u8; 32][..]));
        assert_eq!(got.nonce.as_deref(), Some(&[2u8; 24][..]));
    }

    #[tokio::test]
    async fn load_enc_group_state_point_query() {
        let pool = test_pool().await;

        save_enc_group_state(&pool, "room1", "room", b"state_data_1").await.unwrap();
        save_enc_group_state(&pool, "room2", "room", b"state_data_2").await.unwrap();

        let state = load_enc_group_state(&pool, "room1").await.unwrap();
        assert_eq!(state.as_deref(), Some(b"state_data_1".as_ref()));

        let missing = load_enc_group_state(&pool, "nonexistent").await.unwrap();
        assert!(missing.is_none());
    }
}

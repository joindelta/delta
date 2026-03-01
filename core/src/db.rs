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
            is_public       INTEGER NOT NULL DEFAULT 0,
            creator_key     TEXT NOT NULL,
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
            archived_at     INTEGER
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
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrgRow {
    pub org_id: String,
    pub name: String,
    pub type_label: String,
    pub description: Option<String>,
    pub avatar_blob_id: Option<String>,
    pub cover_blob_id: Option<String>,
    pub is_public: i64,
    pub creator_key: String,
    pub created_at: i64,
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
        r#"INSERT INTO profiles (public_key, username, avatar_blob_id, bio, available_for, is_public, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(public_key) DO UPDATE SET
               username = excluded.username,
               avatar_blob_id = excluded.avatar_blob_id,
               bio = excluded.bio,
               available_for = excluded.available_for,
               is_public = excluded.is_public,
               updated_at = excluded.updated_at"#,
    )
    .bind(&row.public_key)
    .bind(&row.username)
    .bind(&row.avatar_blob_id)
    .bind(&row.bio)
    .bind(&row.available_for)
    .bind(row.is_public)
    .bind(row.created_at)
    .bind(row.updated_at)
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
        r#"INSERT INTO organizations (org_id, name, type_label, description, avatar_blob_id, cover_blob_id, is_public, creator_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id) DO UPDATE SET
               name = excluded.name,
               type_label = excluded.type_label,
               description = excluded.description,
               avatar_blob_id = excluded.avatar_blob_id,
               cover_blob_id = excluded.cover_blob_id,
               is_public = excluded.is_public"#,
    )
    .bind(&row.org_id)
    .bind(&row.name)
    .bind(&row.type_label)
    .bind(&row.description)
    .bind(&row.avatar_blob_id)
    .bind(&row.cover_blob_id)
    .bind(row.is_public as i64)
    .bind(&row.creator_key)
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
    is_public: Option<bool>,
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
    if is_public.is_some() {
        query_parts.push("is_public = ?");
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
    if let Some(is_public) = is_public {
        q = q.bind(is_public as i64);
    }
    
    q.bind(org_id).execute(pool).await?;
    Ok(())
}

pub async fn update_room(
    pool: &SqlitePool,
    room_id: &str,
    name: Option<&str>,
) -> Result<(), DbError> {
    if let Some(name) = name {
        sqlx::query("UPDATE rooms SET name = ? WHERE room_id = ?")
            .bind(name)
            .bind(room_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn list_orgs_for_member(pool: &SqlitePool, member_key: &str) -> Result<Vec<OrgRow>, DbError> {
    let rows = sqlx::query(
        r#"SELECT o.org_id, o.name, o.type_label, o.description, o.avatar_blob_id, o.cover_blob_id,
                  o.is_public, o.creator_key, o.created_at
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
            is_public: r.get::<i64, _>("is_public"),
            creator_key: r.get("creator_key"),
            created_at: r.get("created_at"),
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

// ─── Room ────────────────────────────────────────────────────────────────────

pub async fn insert_room(pool: &SqlitePool, row: &RoomRow) -> Result<(), DbError> {
    sqlx::query(
        r#"INSERT INTO rooms (room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id) DO UPDATE SET 
               name = excluded.name, 
               enc_key_epoch = excluded.enc_key_epoch,
               is_archived = excluded.is_archived,
               archived_at = excluded.archived_at"#,
    )
    .bind(&row.room_id)
    .bind(&row.org_id)
    .bind(&row.name)
    .bind(&row.created_by)
    .bind(row.created_at)
    .bind(row.enc_key_epoch as i64)
    .bind(row.is_archived as i64)
    .bind(row.archived_at)
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
        "SELECT room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at FROM rooms WHERE room_id = ?"
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
    }))
}

pub async fn list_rooms(pool: &SqlitePool, org_id: &str, include_archived: bool) -> Result<Vec<RoomRow>, DbError> {
    let query = if include_archived {
        "SELECT room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at FROM rooms WHERE org_id = ? ORDER BY created_at ASC"
    } else {
        "SELECT room_id, org_id, name, created_by, created_at, enc_key_epoch, is_archived, archived_at FROM rooms WHERE org_id = ? AND is_archived = 0 ORDER BY created_at ASC"
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
        })
        .collect())
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
                "SELECT * FROM messages WHERE room_id = ? AND timestamp < ? AND is_deleted = 0 ORDER BY timestamp DESC LIMIT ?"
            )
            .bind(rid).bind(before).bind(limit as i64)
            .fetch_all(pool).await?
        }
        (Some(rid), _, None) => {
            sqlx::query(
                "SELECT * FROM messages WHERE room_id = ? AND is_deleted = 0 ORDER BY timestamp DESC LIMIT ?"
            )
            .bind(rid).bind(limit as i64)
            .fetch_all(pool).await?
        }
        (_, Some(tid), Some(before)) => {
            sqlx::query(
                "SELECT * FROM messages WHERE dm_thread_id = ? AND timestamp < ? AND is_deleted = 0 ORDER BY timestamp DESC LIMIT ?"
            )
            .bind(tid).bind(before).bind(limit as i64)
            .fetch_all(pool).await?
        }
        (_, Some(tid), None) => {
            sqlx::query(
                "SELECT * FROM messages WHERE dm_thread_id = ? AND is_deleted = 0 ORDER BY timestamp DESC LIMIT ?"
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
        r#"INSERT INTO dm_threads (thread_id, initiator_key, recipient_key, created_at, last_message_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET last_message_at = excluded.last_message_at"#,
    )
    .bind(&row.thread_id)
    .bind(&row.initiator_key)
    .bind(&row.recipient_key)
    .bind(row.created_at)
    .bind(row.last_message_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_dm_threads(pool: &SqlitePool, my_key: &str) -> Result<Vec<DmThreadRow>, DbError> {
    let rows = sqlx::query(
        r#"SELECT thread_id, initiator_key, recipient_key, created_at, last_message_at
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
        })
        .collect())
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
        r#"SELECT thread_id, initiator_key, recipient_key, created_at, last_message_at
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

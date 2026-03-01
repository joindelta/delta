//! Projector — reads new ops from the p2panda store and materialises them
//! into the SQLite read model.
//!
//! Design: a simple polling loop (500 ms) that:
//!  1. Iterates over all known log types.
//!  2. For each type, gets all (author, latest_seq_num) pairs from the op store.
//!  3. Compares against the stored cursor.
//!  4. Fetches new ops and dispatches to the appropriate db helper.
//!
//! Real-time delivery (Phase 3) will add push notifications via p2panda-net
//! Gossip on top of this foundation.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use p2panda_core::PublicKey;
use p2panda_encryption::key_registry::KeyRegistry;
use p2panda_encryption::key_bundle::LongTermKeyBundle;
use p2panda_store::LogStore;
use sqlx::SqlitePool;

use crate::db::{self, MessageRow, OrgRow, ProfileRow, RoomRow, DmThreadRow};
use crate::encryption::{Id, get_encryption};
use crate::ops::{decode_cbor, log_ids, MessageOp, OrgOp, OrgUpdateOp, ProfileOp, ReactionOp, RoomOp, RoomDeleteOp, RoomUpdateOp, DmThreadOp};
use crate::store::get_core;

fn now_micros() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64
}

pub async fn run_projector(read_pool: SqlitePool) {
    let mut interval = tokio::time::interval(Duration::from_millis(500));
    loop {
        interval.tick().await;
        if let Err(e) = project_tick(&read_pool).await {
            eprintln!("[projector] error: {e}");
        }
    }
}

async fn project_tick(read_pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let core = match get_core() {
        Some(c) => c,
        None => return Ok(()),
    };

    let op_store = core.op_store.lock().await;

    for &log_id in log_ids::ALL {
        let log_id_str = log_id.to_string();

        // Heights: Vec<(PublicKey, seq_num)> — all authors who have ops of this type.
        let heights = op_store.get_log_heights(&log_id_str).await?;

        for (public_key, _tip_seq) in heights {
            let pk_hex = public_key.to_hex();

            // Where did we last stop?
            let cursor = db::get_cursor(read_pool, log_id, &pk_hex).await?;

            // Fetch ops from cursor+1 onward.
            let from = if cursor == 0 { None } else { Some(cursor + 1) };
            let Some(ops) = op_store.get_log(&public_key, &log_id_str, from).await? else {
                continue;
            };

            for (header, body_opt) in ops {
                let seq = header.seq_num;
                let op_hash_hex = header.hash().to_hex();

                let body_bytes = match body_opt {
                    Some(b) => b.to_bytes(),
                    None => continue,
                };

                // Dispatch to the right handler.
                let result = match log_id {
                    log_ids::PROFILE => {
                        project_profile(read_pool, &pk_hex, &body_bytes, now_micros()).await
                    }
                    log_ids::ORG => {
                        project_org(read_pool, &pk_hex, &op_hash_hex, &body_bytes, now_micros()).await
                    }
                    log_ids::ROOM => {
                        project_room(read_pool, &pk_hex, &op_hash_hex, &body_bytes, now_micros()).await
                    }
                    log_ids::MESSAGE => {
                        project_message(
                            read_pool,
                            &pk_hex,
                            &op_hash_hex,
                            &body_bytes,
                            header.timestamp as i64,
                        )
                        .await
                    }
                    log_ids::REACTION => {
                        project_reaction(read_pool, &pk_hex, &body_bytes).await
                    }
                    log_ids::DM_THREAD => {
                        project_dm_thread(
                            read_pool,
                            &pk_hex,
                            &op_hash_hex,
                            &body_bytes,
                            now_micros(),
                        )
                        .await
                    }
                    log_ids::MEMBERSHIP => {
                        project_membership(read_pool, &pk_hex, &body_bytes, now_micros()).await
                    }
                    _ => Ok(()),
                };

                if let Err(e) = result {
                    eprintln!("[projector] failed to project {log_id} op {op_hash_hex}: {e}");
                }

                db::set_cursor(read_pool, log_id, &pk_hex, seq).await?;
            }
        }
    }

    Ok(())
}

async fn project_profile(
    pool: &SqlitePool,
    author_key: &str,
    body: &[u8],
    now: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let op: ProfileOp = decode_cbor(body)?;
    let existing = db::get_profile(pool, author_key).await?;
    let created_at = existing.as_ref().map(|p| p.created_at).unwrap_or(now);
    db::upsert_profile(
        pool,
        &ProfileRow {
            public_key: author_key.to_string(),
            username: op.username,
            avatar_blob_id: op.avatar_blob_id,
            bio: op.bio,
            available_for: serde_json::to_string(&op.available_for).unwrap_or_default(),
            is_public: Some(if op.is_public { 1 } else { 0 }),
            created_at,
            updated_at: now,
        },
    )
    .await?;

    // Register the sender's pre-key bundle in our KeyRegistry so we can
    // later call GroupState::add(member) without MissingPreKeys errors.
    if let Some(bundle_bytes) = op.pre_key_bundle {
        if let Some(enc) = get_encryption() {
            // Decode author public key.
            if let Ok(pk_bytes) = hex::decode(author_key) {
                if let Ok(pk_arr) = <[u8; 32]>::try_from(pk_bytes.as_slice()) {
                    if let Ok(author_pk) = PublicKey::from_bytes(&pk_arr) {
                        let author_id = Id(author_pk);
                        // Deserialise the LongTermKeyBundle.
                        if let Ok(bundle) = ciborium::from_reader::<LongTermKeyBundle, _>(
                            bundle_bytes.as_slice(),
                        ) {
                            let mut kr = enc.key_registry.lock().await;
                            if let Ok(new_kr) = KeyRegistry::add_longterm_bundle(
                                kr.clone(),
                                author_id,
                                bundle,
                            ) {
                                *kr = new_kr.clone();
                                // Persist to DB so the registry survives restarts.
                                let mut buf = Vec::new();
                                if ciborium::into_writer(&new_kr, &mut buf).is_ok() {
                                    let _ = crate::db::save_enc_key_registry(pool, &buf).await;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

async fn project_org(
    pool: &SqlitePool,
    author_key: &str,
    op_hash: &str,
    body: &[u8],
    now: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Try to decode as OrgUpdateOp first
    if let Ok(update_op) = decode_cbor::<OrgUpdateOp>(body) {
        if update_op.op_type == "update_org" {
            db::update_org(
                pool,
                &update_op.org_id,
                update_op.name.as_deref(),
                update_op.type_label.as_deref(),
                update_op.description.as_deref(),
                update_op.avatar_blob_id.as_deref(),
                update_op.cover_blob_id.as_deref(),
                update_op.is_public,
            ).await?;
            return Ok(());
        }
    }

    let op: OrgOp = decode_cbor(body)?;
    // The first op for this org sets org_id; subsequent updates reuse it.
    // For simplicity we use the op hash as org_id on create.
    db::insert_org(
        pool,
        &OrgRow {
            org_id: op_hash.to_string(),
            name: op.name,
            type_label: op.type_label,
            description: op.description,
            avatar_blob_id: op.avatar_blob_id,
            cover_blob_id: op.cover_blob_id,
            is_public: op.is_public as i64,
            creator_key: author_key.to_string(),
            created_at: now,
        },
    )
    .await?;
    // Auto-enroll creator as "manage"-level member.
    db::upsert_membership(pool, op_hash, author_key, "manage", now).await?;
    Ok(())
}

async fn project_room(
    pool: &SqlitePool,
    author_key: &str,
    op_hash: &str,
    body: &[u8],
    now: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Try to decode as RoomUpdateOp first
    if let Ok(update_op) = decode_cbor::<RoomUpdateOp>(body) {
        if update_op.op_type == "update_room" {
            db::update_room(pool, &update_op.room_id, update_op.name.as_deref()).await?;
            return Ok(());
        }
    }

    // Try to decode as RoomDeleteOp (for delete/archive operations)
    if let Ok(delete_op) = decode_cbor::<RoomDeleteOp>(body) {
        match delete_op.op_type.as_str() {
            "delete_room" => {
                db::delete_room(pool, &delete_op.room_id).await?;
                return Ok(());
            }
            "archive_room" => {
                db::archive_room(pool, &delete_op.room_id, now).await?;
                return Ok(());
            }
            _ => {}
        }
    }

    // Otherwise decode as regular RoomOp
    let op: RoomOp = decode_cbor(body)?;
    db::insert_room(
        pool,
        &RoomRow {
            room_id: op_hash.to_string(),
            org_id: op.org_id,
            name: op.name,
            created_by: author_key.to_string(),
            created_at: now,
            enc_key_epoch: op.enc_key_epoch,
            is_archived: false,
            archived_at: None,
        },
    )
    .await?;
    Ok(())
}

async fn project_message(
    pool: &SqlitePool,
    author_key: &str,
    op_hash: &str,
    body: &[u8],
    timestamp: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let op: MessageOp = decode_cbor(body)?;
    let is_deleted = op.op_type == "delete";
    db::insert_message(
        pool,
        &MessageRow {
            message_id: op_hash.to_string(),
            room_id: op.room_id,
            dm_thread_id: op.dm_thread_id,
            author_key: author_key.to_string(),
            content_type: op.content_type,
            text_content: op.text_content,
            blob_id: op.blob_id,
            embed_url: op.embed_url,
            mentions: op.mentions,
            reply_to: op.reply_to,
            timestamp,
            edited_at: None,
            is_deleted,
        },
    )
    .await?;
    Ok(())
}

async fn project_reaction(
    pool: &SqlitePool,
    author_key: &str,
    body: &[u8],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let op: ReactionOp = decode_cbor(body)?;
    match op.op_type.as_str() {
        "add_reaction" => db::upsert_reaction(pool, &op.message_id, &op.emoji, author_key).await?,
        "remove_reaction" => {
            db::delete_reaction(pool, &op.message_id, &op.emoji, author_key).await?
        }
        _ => {}
    }
    Ok(())
}

async fn project_dm_thread(
    pool: &SqlitePool,
    author_key: &str,
    op_hash: &str,
    body: &[u8],
    now: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let op: DmThreadOp = decode_cbor(body)?;
    db::insert_dm_thread(
        pool,
        &DmThreadRow {
            thread_id: op_hash.to_string(),
            initiator_key: author_key.to_string(),
            recipient_key: op.recipient_key,
            created_at: now,
            last_message_at: None,
        },
    )
    .await?;
    Ok(())
}

async fn project_membership(
    pool: &SqlitePool,
    _author_key: &str,
    body: &[u8],
    now: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::ops::MembershipOp;
    
    let op: MembershipOp = decode_cbor(body)?;
    
    match op.op_type.as_str() {
        "add_member" => {
            if let Some(access_level) = op.access_level {
                db::upsert_membership(
                    pool,
                    &op.org_id,
                    &op.member_key,
                    &access_level,
                    now,
                )
                .await?;
            }
        }
        "remove_member" => {
            let query = "DELETE FROM memberships WHERE org_id = ? AND member_key = ?";
            sqlx::query(query)
                .bind(&op.org_id)
                .bind(&op.member_key)
                .execute(pool)
                .await?;
        }
        "change_permission" => {
            if let Some(access_level) = op.access_level {
                db::upsert_membership(
                    pool,
                    &op.org_id,
                    &op.member_key,
                    &access_level,
                    now,
                )
                .await?;
            }
        }
        _ => {}
    }
    
    Ok(())
}

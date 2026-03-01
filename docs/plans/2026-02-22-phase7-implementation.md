# Phase 7 — Blobs, Pre-key Bundles & DCGKA Room Encryption

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete Phase 7 — wire pre-key bundle publishing, full DCGKA `GroupState` room encryption, and blob upload/download with encryption, plus the React Native media components.

**Architecture:** Pre-key bundles are published in `ProfileOp` and registered in `KeyRegistryState` by the projector. `init_room_group` creates a per-room `DeltaGroupState` (persisted CBOR in `enc_group_state`). `upload_blob` encrypts via `GroupState::send`; `get_blob` decrypts via `GroupState::receive`. React Native gets `BlobImage`, a wired `MessageComposer`, and a `GifSearchModal`.

**Tech Stack:** Rust / p2panda-encryption 0.5.1 (data_scheme `GroupState`, `KeyManager`, `KeyRegistry`), UniFFI, React Native, react-native-image-picker, expo-av, Tenor API

---

## Task 1: Add `pre_key_bundle` to `ProfileOp`

**Files:**
- Modify: `core/src/ops.rs` — add field to `ProfileOp`

**Step 1: Add field**

In `core/src/ops.rs`, change `ProfileOp`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct ProfileOp {
    pub op_type: String,
    pub username: String,
    pub avatar_blob_id: Option<String>,
    pub bio: Option<String>,
    pub available_for: Vec<String>,
    #[serde(default)]
    pub pre_key_bundle: Option<Vec<u8>>, // CBOR-encoded LongTermKeyBundle
}
```

`#[serde(default)]` ensures old ops without this field still deserialise correctly.

**Step 2: Verify it compiles**

```bash
cd core && cargo check 2>&1 | grep -E "^error"
```
Expected: no output.

**Step 3: Commit**

```bash
git add core/src/ops.rs
git commit -m "feat(phase7): add pre_key_bundle field to ProfileOp"
```

---

## Task 2: Include pre-key bundle when publishing a profile

**Files:**
- Modify: `core/src/lib.rs` — `create_or_update_profile()`

**Step 1: Add imports at top of lib.rs** (after existing use statements)

```rust
use p2panda_encryption::key_manager::KeyManager;
use p2panda_encryption::traits::PreKeyManager;
```

**Step 2: Update `create_or_update_profile()`**

Find the block that constructs `ProfileOp` inside `create_or_update_profile()` (around line 228) and replace:

```rust
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
    },
)
```

with:

```rust
// Fetch own pre-key bundle from EncryptionCore if available.
let pre_key_bundle: Option<Vec<u8>> = encryption::get_encryption().and_then(|enc| {
    let km = enc.key_manager.try_lock().ok()?;
    let bundle = KeyManager::prekey_bundle(&km).ok()?;
    let mut buf = Vec::new();
    ciborium::into_writer(&bundle, &mut buf).ok()?;
    Some(buf)
});

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
        pre_key_bundle,
    },
)
```

**Step 3: Verify it compiles**

```bash
cd core && cargo check 2>&1 | grep -E "^error"
```
Expected: no output.

**Step 4: Commit**

```bash
git add core/src/lib.rs
git commit -m "feat(phase7): include pre_key_bundle in ProfileOp when publishing profile"
```

---

## Task 3: Register received pre-key bundles in the projector

**Files:**
- Modify: `core/src/projector.rs` — `project_profile()`

**Step 1: Add imports** (at top of projector.rs, with existing imports)

```rust
use p2panda_core::PublicKey;
use p2panda_encryption::key_registry::KeyRegistry;
use p2panda_encryption::key_bundle::LongTermKeyBundle;
use p2panda_encryption::traits::PreKeyRegistry;

use crate::encryption::{Id, get_encryption};
```

**Step 2: Update `project_profile()`**

After the `db::upsert_profile(...)` call, append:

```rust
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
```

Note: `project_profile` must become `async fn` if it isn't already (it takes `pool: &SqlitePool` so it can call async DB helpers — check signature and add `async` + `.await` as needed; the calling `project_tick` already uses `.await` on the result).

**Step 3: Verify it compiles**

```bash
cd core && cargo check 2>&1 | grep -E "^error"
```

**Step 4: Write a unit test in `encryption.rs`**

Add to the `encryption_core_tests` module in `core/src/encryption.rs`:

```rust
#[tokio::test]
async fn register_longterm_bundle_round_trip() {
    use p2panda_encryption::key_manager::KeyManager;
    use p2panda_encryption::key_registry::KeyRegistry;
    use p2panda_encryption::traits::{PreKeyManager, PreKeyRegistry};
    use sqlx::sqlite::SqlitePoolOptions;

    let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    let privkey = p2panda_core::PrivateKey::new();
    init_encryption(privkey.to_hex(), pool.clone()).await.unwrap();

    let enc = get_encryption().unwrap();
    // Get our own bundle.
    let km = enc.key_manager.lock().await;
    let bundle = KeyManager::prekey_bundle(&km).unwrap();
    drop(km);

    // Register it for a dummy peer identity (using our own key for simplicity).
    let peer_id = Id(privkey.public_key());
    let kr = enc.key_registry.lock().await.clone();
    let new_kr = KeyRegistry::add_longterm_bundle(kr, peer_id, bundle).unwrap();

    // Retrieve it back.
    let (_, retrieved) = KeyRegistry::<Id>::key_bundle(new_kr, &peer_id).unwrap();
    assert!(retrieved.is_some(), "bundle should be retrievable after registration");
}
```

**Step 5: Run test**

```bash
cd core && cargo test register_longterm_bundle_round_trip -- --nocapture
```
Expected: PASS

**Step 6: Commit**

```bash
git add core/src/projector.rs core/src/encryption.rs
git commit -m "feat(phase7): register pre_key_bundles from ProfileOps into KeyRegistry"
```

---

## Task 4: Add `blob_meta` DB table and helpers

**Files:**
- Modify: `core/src/db.rs`

**Step 1: Add table to schema**

In `run_migrations()`, inside the big SQL string, add after the `enc_group_state` block:

```sql
CREATE TABLE IF NOT EXISTS blob_meta (
    blob_hash    TEXT PRIMARY KEY,
    mime_type    TEXT NOT NULL,
    is_encrypted INTEGER NOT NULL DEFAULT 0,
    room_id      TEXT
);
```

**Step 2: Add row type and helpers**

At the bottom of `core/src/db.rs`, add:

```rust
// ─── Blob metadata ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BlobMeta {
    pub blob_hash: String,
    pub mime_type: String,
    pub is_encrypted: bool,
    pub room_id: Option<String>,
}

pub async fn insert_blob_meta(
    pool: &SqlitePool,
    blob_hash: &str,
    mime_type: &str,
    is_encrypted: bool,
    room_id: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO blob_meta (blob_hash, mime_type, is_encrypted, room_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(blob_hash) DO NOTHING",
    )
    .bind(blob_hash)
    .bind(mime_type)
    .bind(is_encrypted as i64)
    .bind(room_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_blob_meta(
    pool: &SqlitePool,
    blob_hash: &str,
) -> Result<Option<BlobMeta>, DbError> {
    let row = sqlx::query(
        "SELECT blob_hash, mime_type, is_encrypted, room_id
         FROM blob_meta WHERE blob_hash = ?",
    )
    .bind(blob_hash)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| BlobMeta {
        blob_hash: r.get("blob_hash"),
        mime_type: r.get("mime_type"),
        is_encrypted: r.get::<i64, _>("is_encrypted") != 0,
        room_id: r.get("room_id"),
    }))
}
```

Also add a point-query helper for `enc_group_state` (currently only `load_all` exists):

```rust
pub async fn load_enc_group_state(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<Option<Vec<u8>>, DbError> {
    let row = sqlx::query(
        "SELECT state_data FROM enc_group_state WHERE group_id = ?",
    )
    .bind(group_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.get::<Vec<u8>, _>("state_data")))
}
```

**Step 3: Verify**

```bash
cd core && cargo check 2>&1 | grep -E "^error"
```

**Step 4: Commit**

```bash
git add core/src/db.rs
git commit -m "feat(phase7): add blob_meta table, BlobMeta helpers, load_enc_group_state"
```

---

## Task 5: Wire `init_room_group`

**Files:**
- Modify: `core/src/encryption.rs` — replace the stub

**Step 1: Write a failing test first**

Add to `core/src/encryption.rs`, inside the `encryption_core_tests` module:

```rust
#[tokio::test]
async fn init_room_group_creates_group_state() {
    use sqlx::sqlite::SqlitePoolOptions;

    let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    let privkey = p2panda_core::PrivateKey::new();
    init_encryption(privkey.to_hex(), pool.clone()).await.unwrap();

    // Simulate DeltaCore being set so init_room_group can access read_pool.
    // Use a dummy store bootstrap.
    // (If DeltaCore isn't set, init_room_group returns NotInitialised.)
    // We test the encryption layer directly by passing the pool:
    let result = init_room_group_with_pool("room-test-001", vec![privkey.public_key()], &pool).await;
    assert!(result.is_ok(), "init_room_group should succeed: {:?}", result.err());

    // Group state should be persisted.
    let stored = crate::db::load_enc_group_state(&pool, "room-test-001").await.unwrap();
    assert!(stored.is_some(), "group state should be saved to DB");
}
```

Note: we'll expose `init_room_group_with_pool` as a `pub(crate)` testable helper.

**Step 2: Run test to verify it fails**

```bash
cd core && cargo test init_room_group_creates_group_state -- --nocapture 2>&1 | tail -5
```
Expected: compile error `init_room_group_with_pool not found`.

**Step 3: Implement**

Replace the stub `init_room_group` and add the pool-parameterised helper in `core/src/encryption.rs`:

```rust
use p2panda_encryption::data_scheme::GroupState;
use p2panda_encryption::crypto::Rng;

/// Internal helper (also used by tests) that takes an explicit pool.
pub(crate) async fn init_room_group_with_pool(
    room_id: &str,
    initial_members: Vec<p2panda_core::PublicKey>,
    pool: &sqlx::SqlitePool,
) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let rng = Rng::default();

    // Clone states out of the Mutexes — GroupState::init takes ownership.
    let km_state = enc.key_manager.lock().await.clone();
    let kr_state = enc.key_registry.lock().await.clone();

    let my_id = Id(enc.my_public_key);
    let all_ids: Vec<Id> = initial_members.iter().map(|pk| Id(*pk)).collect();

    // Build initial DGM + ordering state.
    let dgm_state = DeltaDgm::create(my_id, &all_ids)
        .map_err(|e| EncryptionError::Init(format!("DGM create: {e:?}")))?;
    let ord_state = DeltaOrdering::init(enc.my_public_key);

    // Initialise and create the group.
    let y = DeltaGroupState::init(my_id, km_state, kr_state, dgm_state, ord_state);
    let (new_state, ctrl_msg) = DeltaGroupState::create(y, all_ids, &rng)
        .map_err(|e| EncryptionError::Init(format!("GroupState::create: {e:?}")))?;

    // Persist the group state.
    let mut state_buf = Vec::new();
    ciborium::into_writer(&new_state, &mut state_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_group_state(pool, room_id, "room", &state_buf).await?;

    // Serialise the control message.
    let mut ctrl_buf = Vec::new();
    ciborium::into_writer(&ctrl_msg, &mut ctrl_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    // Serialise per-recipient direct messages embedded in the ctrl message.
    let directs: Vec<(String, Vec<u8>)> = ctrl_msg
        .direct_messages()
        .into_iter()
        .filter_map(|dm| {
            let mut buf = Vec::new();
            ciborium::into_writer(&dm, &mut buf).ok()?;
            // The recipient hex is encoded in the direct message; we serialise
            // the whole thing and the peer decodes it on receive.
            Some((hex::encode(buf.get(0..32).unwrap_or(&[])), buf))
        })
        .collect();

    Ok((ctrl_buf, directs))
}

/// Called from lib.rs / UniFFI.
pub async fn init_room_group(
    room_id: &str,
    initial_members: Vec<p2panda_core::PublicKey>,
) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), EncryptionError> {
    let core = crate::store::get_core().ok_or(EncryptionError::NotInitialised)?;
    init_room_group_with_pool(room_id, initial_members, &core.read_pool).await
}
```

**Step 4: Run test**

```bash
cd core && cargo test init_room_group_creates_group_state -- --nocapture
```
Expected: PASS

**Step 5: Commit**

```bash
git add core/src/encryption.rs
git commit -m "feat(phase7): implement init_room_group via GroupState::create"
```

---

## Task 6: Wire `encrypt_for_room` and `decrypt_for_room`

**Files:**
- Modify: `core/src/encryption.rs`

**Step 1: Add `sender_key` to `EncryptedBody`**

Find `EncryptedBody` (near bottom of encryption.rs) and update it:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptedBody {
    pub secret_id:  GroupSecretId,  // [u8; 32]
    pub nonce:      [u8; 24],
    pub ciphertext: Vec<u8>,
    pub sender_key: [u8; 32],       // sender's Ed25519 public key bytes
}
```

**Step 2: Add needed import**

```rust
use p2panda_encryption::data_scheme::GroupOutput;
```

**Step 3: Write a failing round-trip test**

In the `room_encrypt_tests` module (already exists near the bottom of encryption.rs), add:

```rust
#[tokio::test]
async fn encrypt_decrypt_for_room_roundtrip() {
    use sqlx::sqlite::SqlitePoolOptions;

    let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    let privkey = p2panda_core::PrivateKey::new();
    init_encryption(privkey.to_hex(), pool.clone()).await.unwrap();

    // Create the room group first.
    init_room_group_with_pool("test-room", vec![privkey.public_key()], &pool)
        .await
        .expect("init_room_group should succeed");

    let plaintext = b"hello encrypted blob";

    // Encrypt.
    let enc_bytes = encrypt_for_room_with_pool("test-room", plaintext, &pool)
        .await
        .expect("encrypt should succeed");

    // Decrypt.
    let recovered = decrypt_for_room_with_pool("test-room", &enc_bytes, &pool)
        .await
        .expect("decrypt should return Some");

    assert_eq!(recovered, plaintext, "decrypted plaintext should match");
}
```

**Step 4: Run to verify it fails**

```bash
cd core && cargo test encrypt_decrypt_for_room_roundtrip -- --nocapture 2>&1 | tail -5
```
Expected: compile error (functions not defined yet).

**Step 5: Implement `encrypt_for_room_with_pool` and `decrypt_for_room_with_pool`**

```rust
pub(crate) async fn encrypt_for_room_with_pool(
    room_id: &str,
    plaintext: &[u8],
    pool: &sqlx::SqlitePool,
) -> Result<Vec<u8>, EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let rng = Rng::default();

    // Load group state.
    let state_bytes = crate::db::load_enc_group_state(pool, room_id)
        .await?
        .ok_or_else(|| EncryptionError::Init(format!("no group state for room {room_id}")))?;
    let state: DeltaGroupState = ciborium::from_reader(state_bytes.as_slice())
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    // Encrypt via GroupState::send.
    let (new_state, msg) = DeltaGroupState::send(state, plaintext, &rng)
        .map_err(|e| EncryptionError::Init(format!("GroupState::send: {e:?}")))?;

    // Persist updated state.
    let mut buf = Vec::new();
    ciborium::into_writer(&new_state, &mut buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_group_state(pool, room_id, "room", &buf).await?;

    // Extract ciphertext from the Application message.
    match msg.content {
        DeltaMessageContent::Application { group_secret_id, nonce, ciphertext } => {
            let body = EncryptedBody {
                secret_id: group_secret_id,
                nonce:     nonce,   // XAeadNonce = [u8; 24]
                ciphertext,
                sender_key: enc.my_public_key.as_bytes().try_into()
                    .map_err(|_| EncryptionError::Init("public key size mismatch".into()))?,
            };
            let mut out = Vec::new();
            ciborium::into_writer(&body, &mut out)
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
            Ok(out)
        }
        _ => Err(EncryptionError::Init(
            "GroupState::send returned non-Application message".into(),
        )),
    }
}

pub async fn encrypt_for_room(room_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, EncryptionError> {
    let core = crate::store::get_core().ok_or(EncryptionError::NotInitialised)?;
    encrypt_for_room_with_pool(room_id, plaintext, &core.read_pool).await
}

pub(crate) async fn decrypt_for_room_with_pool(
    room_id: &str,
    body_bytes: &[u8],
    pool: &sqlx::SqlitePool,
) -> Option<Vec<u8>> {
    // Load group state.
    let state_bytes = crate::db::load_enc_group_state(pool, room_id).await.ok()??;
    let state: DeltaGroupState = ciborium::from_reader(state_bytes.as_slice()).ok()?;

    // Deserialise EncryptedBody.
    let body: EncryptedBody = ciborium::from_reader(body_bytes).ok()?;
    let sender_pk = p2panda_core::PublicKey::from_bytes(&body.sender_key).ok()?;

    // Reconstruct a DeltaMessage::Application.
    let msg = DeltaMessage {
        id: OpId(p2panda_core::Hash::new(&body.ciphertext)),
        sender: Id(sender_pk),
        content: DeltaMessageContent::Application {
            group_secret_id: body.secret_id,
            nonce:            body.nonce,  // [u8; 24] == XAeadNonce
            ciphertext:       body.ciphertext,
        },
    };

    // Decrypt via GroupState::receive.
    let (new_state, outputs) = DeltaGroupState::receive(state, &msg).ok()?;

    // Persist updated state.
    let mut buf = Vec::new();
    if ciborium::into_writer(&new_state, &mut buf).is_ok() {
        let _ = crate::db::save_enc_group_state(pool, room_id, "room", &buf).await;
    }

    // Find the decrypted payload.
    for output in outputs {
        if let GroupOutput::Application { plaintext } = output {
            return Some(plaintext);
        }
    }
    None
}

pub async fn decrypt_for_room(room_id: &str, body_bytes: &[u8]) -> Option<Vec<u8>> {
    let core = crate::store::get_core()?;
    decrypt_for_room_with_pool(room_id, body_bytes, &core.read_pool).await
}
```

**Step 6: Run the round-trip test**

```bash
cd core && cargo test encrypt_decrypt_for_room_roundtrip -- --nocapture
```
Expected: PASS

**Step 7: Commit**

```bash
git add core/src/encryption.rs
git commit -m "feat(phase7): implement encrypt_for_room and decrypt_for_room via GroupState"
```

---

## Task 7: Update `blobs.rs` — new signatures + encryption integration

**Files:**
- Modify: `core/src/blobs.rs`

**Step 1: Write a failing test**

Add at the bottom of `core/src/blobs.rs`:

```rust
#[cfg(test)]
mod tests {
    // Integration-style tests live in encryption.rs where DeltaCore is easier
    // to boot. Here we just sanity-check the hash function.
    #[test]
    fn blob_hash_is_deterministic() {
        use p2panda_core::Hash;
        let data = b"test blob content";
        let h1 = Hash::new(data).to_hex();
        let h2 = Hash::new(data).to_hex();
        assert_eq!(h1, h2);
    }
}
```

**Step 2: Rewrite `blobs.rs` completely**

```rust
use crate::{db, encryption, store};
use p2panda_core::Hash;
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("Core not initialized")]
    NotInitialized,
    #[error("Blob not found")]
    NotFound,
    #[error("Blob store error: {0}")]
    StoreError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Upload a blob and return its content-hash (hex).
///
/// If `room_id` is `Some`, the blob is encrypted with the room's DCGKA key
/// before writing to disk. Pass `None` for unencrypted blobs (e.g. avatars).
pub async fn upload_blob(
    bytes: Vec<u8>,
    mime_type: String,
    room_id: Option<String>,
) -> Result<String, BlobError> {
    let core = store::get_core().ok_or(BlobError::NotInitialized)?;

    // Hash computed over PLAINTEXT — content-addressed by original data.
    let hash_str = Hash::new(&bytes).to_hex();

    let (data_to_write, is_encrypted) = match &room_id {
        Some(rid) => {
            let enc = encryption::encrypt_for_room(rid, &bytes)
                .await
                .map_err(|e| BlobError::StoreError(e.to_string()))?;
            (enc, true)
        }
        None => (bytes, false),
    };

    // Write bytes to the blob store directory.
    let blob_path = core.blob_store.join(&hash_str);
    fs::write(&blob_path, &data_to_write).await?;

    // Record metadata so get_blob knows whether/how to decrypt.
    db::insert_blob_meta(
        &core.read_pool,
        &hash_str,
        &mime_type,
        is_encrypted,
        room_id.as_deref(),
    )
    .await
    .map_err(|e| BlobError::StoreError(e.to_string()))?;

    Ok(hash_str)
}

/// Retrieve a blob by its hash, decrypting if necessary.
pub async fn get_blob(hash_str: String) -> Result<Vec<u8>, BlobError> {
    let core = store::get_core().ok_or(BlobError::NotInitialized)?;

    let blob_path = core.blob_store.join(&hash_str);
    let file_bytes = fs::read(&blob_path).await?;

    // Look up metadata.
    let meta = db::get_blob_meta(&core.read_pool, &hash_str)
        .await
        .map_err(|e| BlobError::StoreError(e.to_string()))?
        .ok_or(BlobError::NotFound)?;

    if meta.is_encrypted {
        let room_id = meta
            .room_id
            .ok_or_else(|| BlobError::StoreError("encrypted blob missing room_id".into()))?;
        encryption::decrypt_for_room(&room_id, &file_bytes)
            .await
            .ok_or_else(|| BlobError::StoreError("decryption failed".into()))
    } else {
        Ok(file_bytes)
    }
}

/// Returns the blob store directory for the given db_dir.
pub fn blob_store_path(db_dir: &str) -> PathBuf {
    PathBuf::from(db_dir).join("blobs")
}
```

**Step 3: Verify**

```bash
cd core && cargo check 2>&1 | grep -E "^error"
```

**Step 4: Run test**

```bash
cd core && cargo test blob_hash_is_deterministic
```
Expected: PASS

**Step 5: Commit**

```bash
git add core/src/blobs.rs
git commit -m "feat(phase7): rewrite blobs.rs with mime_type, room_id, encrypted storage"
```

---

## Task 8: Update UDL and `lib.rs` for new `upload_blob` signature

**Files:**
- Modify: `core/src/delta_core.udl`
- Modify: `core/src/lib.rs`

**Step 1: Update UDL**

In `core/src/delta_core.udl`, replace the Phase 7 blob block:

```
// ── Phase 7: Blobs ─────────────────────────────────────────────────────
[Async, Throws=BlobError]
string upload_blob(bytes data, string mime_type, string? room_id);

[Async, Throws=BlobError]
bytes get_blob(string blob_hash);
```

**Step 2: Update `lib.rs` re-export**

The `blobs::upload_blob` signature changed — UniFFI calls it via the UDL. Ensure the function in `blobs.rs` matches the UDL exactly (it does, as written in Task 7).

Also add `BlobError` to the UDL error enum if not already present (it already is — `[Error] enum BlobError { "NotInitialized", "StoreError", "IoError", }` — add `"NotFound"` to match the new variant):

```
[Error]
enum BlobError {
    "NotInitialized",
    "NotFound",
    "StoreError",
    "IoError",
};
```

**Step 3: Full build check**

```bash
cd core && cargo check 2>&1 | grep -E "^error"
```

**Step 4: Commit**

```bash
git add core/src/delta_core.udl core/src/lib.rs
git commit -m "feat(phase7): update UDL for upload_blob(data, mime_type, room_id)"
```

---

## Task 9: Wire TypeScript bridge

**Files:**
- Modify: `app/src/ffi/deltaCore.ts`

**Step 1: Add to `DeltaCoreNative` interface** (after `listOrgMembers`):

```ts
// Phase 7
uploadBlob(data: Uint8Array, mimeType: string, roomId: string | null): Promise<string>;
getBlob(blobHash: string): Promise<Uint8Array>;
```

**Step 2: Add stubs to the fallback object** (in `loadNative()`'s catch block):

```ts
async uploadBlob() { throw new Error('delta_core not loaded'); },
async getBlob() { throw new Error('delta_core not loaded'); },
```

**Step 3: Add exported wrappers** (at the bottom, after `listOrgMembers`):

```ts
// ── Phase 7: Blobs ────────────────────────────────────────────────────────────

export class BlobError extends Error {
  constructor(
    public readonly kind: 'NotInitialized' | 'NotFound' | 'StoreError' | 'IoError',
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

export async function uploadBlob(
  data: Uint8Array,
  mimeType: string,
  roomId: string | null,
): Promise<string> {
  return native.uploadBlob(data, mimeType, roomId);
}

export async function getBlob(blobHash: string): Promise<Uint8Array> {
  return native.getBlob(blobHash);
}
```

**Step 4: Commit**

```bash
git add app/src/ffi/deltaCore.ts
git commit -m "feat(phase7): add uploadBlob and getBlob to TypeScript bridge"
```

---

## Task 10: Create `BlobImage` component

**Files:**
- Create: `app/src/components/BlobImage.tsx`

**Step 1: Write the component**

```tsx
import React, { useEffect, useState } from 'react';
import {
  Image,
  ImageStyle,
  StyleProp,
  View,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { getBlob } from '../ffi/deltaCore';

interface Props {
  blobHash: string;
  style?: StyleProp<ImageStyle>;
  mimeType?: string; // defaults to 'image/jpeg'
}

type State = { status: 'loading' } | { status: 'ready'; uri: string } | { status: 'error' };

export function BlobImage({ blobHash, style, mimeType = 'image/jpeg' }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    getBlob(blobHash)
      .then((bytes) => {
        if (cancelled) return;
        // Convert Uint8Array → base64 string.
        const binary = Array.from(bytes)
          .map((b) => String.fromCharCode(b))
          .join('');
        const b64 = btoa(binary);
        setState({ status: 'ready', uri: `data:${mimeType};base64,${b64}` });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [blobHash, mimeType]);

  if (state.status === 'loading') {
    return (
      <View style={[styles.placeholder, style as object]}>
        <ActivityIndicator color="#888" />
      </View>
    );
  }
  if (state.status === 'error') {
    return <View style={[styles.placeholder, style as object]} />;
  }
  return <Image source={{ uri: state.uri }} style={style} resizeMode="cover" />;
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
    borderRadius: 8,
  },
});
```

**Step 2: Commit**

```bash
git add app/src/components/BlobImage.tsx
git commit -m "feat(phase7): add BlobImage component with lazy blob fetch + base64 render"
```

---

## Task 11: Update `MessageBubble` to render real media

**Files:**
- Modify: `app/src/components/MessageBubble.tsx`

**Step 1: Add import at top of file**

```tsx
import { BlobImage } from './BlobImage';
```

**Step 2: Replace placeholder renderers**

Find and replace the `contentType === 'image'` block:

```tsx
{message.contentType === 'image' && message.blobId && (
  <BlobImage
    blobHash={message.blobId}
    style={styles.mediaBlobImage}
  />
)}
```

Replace the `contentType === 'video'` block:

```tsx
{message.contentType === 'video' && message.blobId && (
  // Poster frame only — full video playback is a future enhancement.
  <BlobImage
    blobHash={message.blobId}
    style={styles.mediaBlobImage}
    mimeType="image/jpeg"
  />
)}
```

Replace the `contentType === 'audio'` block:

```tsx
{message.contentType === 'audio' && message.blobId && (
  <AudioMessage blobHash={message.blobId} />
)}
```

Replace the `contentType === 'gif'` block:

```tsx
{message.contentType === 'gif' && message.embedUrl && (
  <Image
    source={{ uri: message.embedUrl }}
    style={styles.mediaBlobImage}
    resizeMode="cover"
  />
)}
```

**Step 3: Add `AudioMessage` inline component** (just above `MessageBubble` export, same file):

```tsx
import { Audio } from 'expo-av';

function AudioMessage({ blobHash }: { blobHash: string }) {
  const [playing, setPlaying] = useState(false);
  const soundRef = React.useRef<Audio.Sound | null>(null);

  async function toggle() {
    if (playing) {
      await soundRef.current?.pauseAsync();
      setPlaying(false);
    } else {
      // Lazy-load: fetch bytes, write to a data URI, play.
      try {
        const bytes = await getBlob(blobHash);
        const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
        const uri = `data:audio/opus;base64,${btoa(binary)}`;
        const { sound } = await Audio.Sound.createAsync({ uri });
        soundRef.current = sound;
        sound.setOnPlaybackStatusUpdate((s) => {
          if (s.isLoaded && s.didJustFinish) setPlaying(false);
        });
        await sound.playAsync();
        setPlaying(true);
      } catch {
        // silently fail
      }
    }
  }

  return (
    <TouchableOpacity style={styles.audioBtn} onPress={toggle}>
      <Text style={styles.audioBtnText}>{playing ? '⏸' : '▶'}</Text>
      <Text style={styles.audioLabel}>Voice message</Text>
    </TouchableOpacity>
  );
}
```

Add to imports at the top: `import { getBlob } from '../ffi/deltaCore';`

**Step 4: Add new style entries**

```tsx
mediaBlobImage: { width: '100%', minHeight: 160, borderRadius: 8 },
audioBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
audioBtnText: { color: '#fff', fontSize: 20 },
audioLabel: { color: '#ddd', fontSize: 13 },
```

**Step 5: Commit**

```bash
git add app/src/components/MessageBubble.tsx
git commit -m "feat(phase7): render BlobImage, AudioMessage, and GIF in MessageBubble"
```

---

## Task 12: Create `GifSearchModal`

**Files:**
- Create: `app/src/utils/config.ts` (if it doesn't exist)
- Create: `app/src/components/GifSearchModal.tsx`

**Step 1: Create config file**

```ts
// app/src/utils/config.ts
// Replace with your actual Tenor API key before shipping.
export const TENOR_API_KEY = 'YOUR_TENOR_API_KEY_HERE';
```

**Step 2: Write `GifSearchModal`**

```tsx
// app/src/components/GifSearchModal.tsx
import React, { useState, useCallback } from 'react';
import {
  Modal,
  View,
  TextInput,
  FlatList,
  Image,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { TENOR_API_KEY } from '../utils/config';

interface GifResult {
  id: string;
  url: string;
  preview: string;
}

interface Props {
  visible: boolean;
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

export function GifSearchModal({ visible, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const url =
        `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}` +
        `&key=${TENOR_API_KEY}&limit=20&media_filter=gif`;
      const res = await fetch(url);
      const data = await res.json();
      const gifs: GifResult[] = (data.results ?? []).map((r: any) => ({
        id: r.id,
        url: r.media_formats?.gif?.url ?? '',
        preview: r.media_formats?.tinygif?.url ?? r.media_formats?.gif?.url ?? '',
      }));
      setResults(gifs);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TextInput
            style={styles.input}
            placeholder="Search GIFs..."
            placeholderTextColor="#555"
            value={query}
            onChangeText={(t) => { setQuery(t); search(t); }}
            autoFocus
          />
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        {loading && <ActivityIndicator color="#3b82f6" style={{ marginTop: 20 }} />}

        <FlatList
          data={results}
          numColumns={2}
          keyExtractor={(g) => g.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.cell}
              onPress={() => { onSelect(item.url); onClose(); }}
            >
              <Image source={{ uri: item.preview }} style={styles.gif} resizeMode="cover" />
            </TouchableOpacity>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: { flexDirection: 'row', padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  input: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, color: '#fff', fontSize: 15 },
  closeBtn: { justifyContent: 'center', paddingHorizontal: 8 },
  closeText: { color: '#888', fontSize: 20 },
  cell: { flex: 1, margin: 4 },
  gif: { width: '100%', aspectRatio: 1, borderRadius: 6, backgroundColor: '#1a1a1a' },
});
```

**Step 3: Commit**

```bash
git add app/src/utils/config.ts app/src/components/GifSearchModal.tsx
git commit -m "feat(phase7): add GifSearchModal with Tenor search"
```

---

## Task 13: Wire `MessageComposer` — attach button, PTT, GIF

**Files:**
- Modify: `app/src/components/MessageComposer.tsx`

**Step 1: Full rewrite of `MessageComposer.tsx`**

```tsx
import React, { useState, useRef } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActionSheetIOS,
  Alert,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { Audio } from 'expo-av';
import { uploadBlob } from '../ffi/deltaCore';
import { GifSearchModal } from './GifSearchModal';

interface Props {
  roomId: string | null;
  onSend: (text: string) => void;
  onSendBlob: (blobId: string, mimeType: string, contentType: 'image' | 'video') => void;
  onSendAudio: (blobId: string) => void;
  onSendGif: (embedUrl: string) => void;
  placeholder?: string;
  replyingTo?: string | null;
  onCancelReply?: () => void;
}

export function MessageComposer({
  roomId,
  onSend,
  onSendBlob,
  onSendAudio,
  onSendGif,
  placeholder = 'Message...',
  replyingTo,
  onCancelReply,
}: Props) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [gifVisible, setGifVisible] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  function openAttachSheet() {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Photo / Video', 'GIF'], cancelButtonIndex: 0 },
        (idx) => {
          if (idx === 1) pickMedia();
          if (idx === 2) setGifVisible(true);
        },
      );
    } else {
      // Android: simple Alert-based menu (real ActionSheet library can replace this).
      Alert.alert('Attach', '', [
        { text: 'Photo / Video', onPress: pickMedia },
        { text: 'GIF', onPress: () => setGifVisible(true) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }

  async function pickMedia() {
    const result = await launchImageLibrary({ mediaType: 'mixed', includeBase64: false });
    const asset = result.assets?.[0];
    if (!asset || !asset.uri) return;

    const isVideo = asset.type?.startsWith('video') ?? false;
    const mimeType = asset.type ?? (isVideo ? 'video/mp4' : 'image/jpeg');
    const contentType: 'image' | 'video' = isVideo ? 'video' : 'image';

    // Read bytes via fetch (works for both file:// and ph:// URIs on RN).
    const resp = await fetch(asset.uri);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    const blobId = await uploadBlob(bytes, mimeType, roomId);
    onSendBlob(blobId, mimeType, contentType);
  }

  async function startRecording() {
    await Audio.requestPermissionsAsync();
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const { recording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY,
    );
    recordingRef.current = recording;
    setRecording(true);
  }

  async function stopRecording() {
    setRecording(false);
    const rec = recordingRef.current;
    if (!rec) return;
    await rec.stopAndUnloadAsync();
    const uri = rec.getURI();
    if (!uri) return;

    const resp = await fetch(uri);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const blobId = await uploadBlob(bytes, 'audio/m4a', roomId);
    onSendAudio(blobId);
    recordingRef.current = null;
  }

  const showPtt = text.trim().length === 0;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {replyingTo && (
        <View style={styles.replyBar}>
          <Text style={styles.replyText}>Replying to message...</Text>
          {onCancelReply && (
            <TouchableOpacity onPress={onCancelReply}>
              <Text style={styles.cancelText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={styles.container}>
        <TouchableOpacity style={styles.attachBtn} onPress={openAttachSheet}>
          <Text style={styles.attachText}>+</Text>
        </TouchableOpacity>

        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor="#555"
          value={text}
          onChangeText={setText}
          multiline
          maxLength={4000}
          returnKeyType="default"
        />

        {showPtt ? (
          <TouchableOpacity
            style={[styles.pttBtn, recording && styles.pttBtnActive]}
            onPressIn={startRecording}
            onPressOut={stopRecording}
          >
            <Text style={styles.pttText}>🎙</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!text.trim()}
          >
            <Text style={styles.sendText}>↑</Text>
          </TouchableOpacity>
        )}
      </View>

      <GifSearchModal
        visible={gifVisible}
        onSelect={(url) => { onSendGif(url); setGifVisible(false); }}
        onClose={() => setGifVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
    gap: 8,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  replyText: { color: '#888', fontSize: 13 },
  cancelText: { color: '#888', fontSize: 18, paddingHorizontal: 8 },
  attachBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center',
  },
  attachText: { color: '#888', fontSize: 24, fontWeight: '300' },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
    color: '#fff',
    fontSize: 15,
    maxHeight: 100,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#374151', opacity: 0.5 },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '600' },
  pttBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center',
  },
  pttBtnActive: { backgroundColor: '#ef4444' },
  pttText: { fontSize: 18 },
});
```

**Step 2: Commit**

```bash
git add app/src/components/MessageComposer.tsx
git commit -m "feat(phase7): wire MessageComposer — picker, PTT, GIF modal, uploadBlob"
```

---

## Task 14: Final build verification

**Step 1: Run all Rust tests**

```bash
cd core && cargo test 2>&1 | tail -20
```
Expected: all tests pass, no errors.

**Step 2: Run cargo check with release profile**

```bash
cd core && cargo check --release 2>&1 | grep -E "^error"
```
Expected: no output.

**Step 3: Commit any final fixes, then tag**

```bash
git add -p   # review any stray changes
git commit -m "chore(phase7): final cleanup and verification"
```

---

## Notes

- **Pre-key bundle chicken-and-egg**: A room creator can always create a solo group (`[my_id]`). Other members are added via `GroupState::add()` after their profile ops (containing pre-key bundles) arrive via gossip and are projected.
- **GIF API key**: `TENOR_API_KEY` in `app/src/utils/config.ts` is a placeholder — the user must supply a real key before shipping.
- **Audio format**: PTT records to `audio/m4a` (iOS default). Android may need `audio/3gp` — `Audio.RecordingOptionsPresets.HIGH_QUALITY` handles this automatically.
- **Video playback**: Full video playback is deferred; `MessageBubble` shows a poster frame. Wire `expo-av` Video component when needed.
- **`react-native-image-picker` install**: `npm install react-native-image-picker` + iOS `pod install`. Android needs `READ_EXTERNAL_STORAGE` permission.
- **`expo-av` install**: `npx expo install expo-av` + iOS `pod install`. Add `NSMicrophoneUsageDescription` to iOS `Info.plist`.

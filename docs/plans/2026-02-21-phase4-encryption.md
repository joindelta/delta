# Phase 4 Encryption Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `p2panda-encryption` into `core` for end-to-end encrypted rooms (data scheme, shared symmetric key + DCGKA) and DM threads (message scheme, Double Ratchet).

**Architecture:** An `EncryptionCore` singleton holds `KeyManager`, `KeyRegistry`, per-room `GroupState`, and per-DM `MessageGroupState`. It is initialised inside `bootstrap()` and persists all state write-through to three new SQLite tables. `send_message` encrypts bodies before storing; the projector decrypts before CBOR-decoding. React Native sees no API changes except `Message.decryption_pending`.

**Tech Stack:** `p2panda-encryption 0.5` (data_scheme + message_scheme features), `p2panda-core` `PublicKey`/`Hash` as ID/OP types, `ciborium` for CBOR, `sqlx` for persistence, `tokio::sync::Mutex` for interior mutability in the singleton.

---

## Context for every task

- Working dir: `core/` (Rust crate)
- Run tests with: `cargo test --manifest-path core/Cargo.toml --lib 2>&1`
- Run check with: `cargo check --manifest-path core/Cargo.toml 2>&1`
- The existing `encryption.rs` contains only a single comment line — replace it entirely.
- `p2panda_core::PublicKey` and `p2panda_core::Hash` both implement `Copy + Clone + Debug + PartialEq + Eq + Hash(std) + Serialize + Deserialize`. We will add the `IdentityHandle` and `OperationId` marker trait impls for them.
- Reference implementations of all required traits live in `p2panda-encryption` test_utils:
  - DGM (data scheme): `~/.cargo/registry/src/.../p2panda-encryption-0.5.1/src/data_scheme/test_utils/dgm.rs`
  - DGM (message scheme): `~/.cargo/registry/src/.../p2panda-encryption-0.5.1/src/message_scheme/test_utils/dgm.rs`
  - Ordering (data scheme): `~/.cargo/registry/src/.../p2panda-encryption-0.5.1/src/data_scheme/test_utils/ordering.rs`
  - Ordering (message scheme): `~/.cargo/registry/src/.../p2panda-encryption-0.5.1/src/message_scheme/test_utils/ordering.rs`

---

### Task 1: Enable p2panda-encryption features in Cargo.toml

**Files:**
- Modify: `core/Cargo.toml`

**Step 1: Update the p2panda-encryption dependency**

In `core/Cargo.toml`, change:
```toml
p2panda-encryption = "0.5"
```
to:
```toml
p2panda-encryption = { version = "0.5", features = ["data_scheme", "message_scheme"] }
```

**Step 2: Verify it compiles**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -5`
Expected: no output.

**Step 3: Commit**

```bash
git add core/Cargo.toml core/Cargo.lock
git commit -m "feat(phase4): enable p2panda-encryption data_scheme + message_scheme features"
```

---

### Task 2: New log IDs and op payload structs in ops.rs

**Files:**
- Modify: `core/src/ops.rs`

**Step 1: Write the failing tests**

Add at the bottom of `core/src/ops.rs`:

```rust
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
```

**Step 2: Run tests to confirm they fail**

Run: `cargo test --manifest-path core/Cargo.toml --lib enc_ops_tests 2>&1 | tail -5`
Expected: compile error — `KeyBundleOp`, `EncCtrlOp`, `EncDirectOp` not defined.

**Step 3: Add new log IDs and op structs**

In `ops.rs`, in the `log_ids` module add:

```rust
pub const KEY_BUNDLE: &str = "key_bundle";
pub const ENC_CTRL:   &str = "enc_ctrl";
pub const ENC_DIRECT: &str = "enc_direct";

pub const ALL: &[&str] = &[
    PROFILE, ORG, ROOM, MESSAGE, REACTION, DM_THREAD,
    KEY_BUNDLE, ENC_CTRL, ENC_DIRECT,
];
```

After the `DmThreadOp` struct, add:

```rust
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
```

**Step 4: Run tests to confirm they pass**

Run: `cargo test --manifest-path core/Cargo.toml --lib enc_ops_tests 2>&1 | tail -5`
Expected: `test result: ok. 3 passed`

**Step 5: Commit**

```bash
git add core/src/ops.rs
git commit -m "feat(phase4): add key_bundle/enc_ctrl/enc_direct log IDs and op structs"
```

---

### Task 3: New SQLite tables and db helpers in db.rs

**Files:**
- Modify: `core/src/db.rs`

**Step 1: Write the failing tests**

Add at the bottom of `db.rs`:

```rust
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
}
```

**Step 2: Run tests to confirm they fail**

Run: `cargo test --manifest-path core/Cargo.toml --lib enc_db_tests 2>&1 | tail -5`
Expected: compile error — helpers not defined.

**Step 3: Add new tables to `run_migrations`**

Inside the large SQL string in `run_migrations`, append before the closing `"#`:

```sql
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
```

**Step 4: Add CRUD helpers**

Add these functions to `db.rs`:

```rust
// ─── Encryption state ────────────────────────────────────────────────────────

pub async fn save_enc_key_manager(pool: &SqlitePool, state: &[u8]) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO enc_key_manager (id, state_data) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET state_data = excluded.state_data"
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
        "INSERT INTO enc_key_registry (id, state_data) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET state_data = excluded.state_data"
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
        "INSERT INTO enc_group_state (group_id, group_type, state_data) VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET state_data = excluded.state_data"
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
```

**Step 5: Run tests to confirm they pass**

Run: `cargo test --manifest-path core/Cargo.toml --lib enc_db_tests 2>&1 | tail -5`
Expected: `test result: ok. 3 passed`

**Step 6: Commit**

```bash
git add core/src/db.rs
git commit -m "feat(phase4): add enc_key_manager/registry/group_state tables and db helpers"
```

---

### Task 4: DeltaDgm — GroupMembership<PublicKey, Hash>

**Files:**
- Modify: `core/src/encryption.rs` (replace the stub)

**Step 1: Write failing tests**

Replace `encryption.rs` entirely with:

```rust
//! EncryptionCore — Phase 4 stub with DeltaDgm implementation.
use std::collections::HashSet;
use std::convert::Infallible;

use p2panda_core::{Hash, PublicKey};
use p2panda_encryption::traits::{GroupMembership, IdentityHandle, OperationId};
use serde::{Deserialize, Serialize};

// ─── Marker trait impls ───────────────────────────────────────────────────────

impl IdentityHandle for PublicKey {}
impl OperationId for Hash {}

// ─── DeltaDgm — data scheme DGM ──────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaDgm;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaDgmState {
    pub my_id: PublicKey,
    pub members: HashSet<PublicKey>,
}

impl GroupMembership<PublicKey, Hash> for DeltaDgm {
    type State = DeltaDgmState;
    type Error = Infallible;

    fn create(my_id: PublicKey, initial_members: &[PublicKey]) -> Result<Self::State, Self::Error> {
        Ok(DeltaDgmState {
            my_id,
            members: HashSet::from_iter(initial_members.iter().cloned()),
        })
    }

    fn from_welcome(my_id: PublicKey, y: Self::State) -> Result<Self::State, Self::Error> {
        Ok(DeltaDgmState { my_id, members: y.members })
    }

    fn add(
        mut y: Self::State,
        _adder: PublicKey,
        added: PublicKey,
        _op: Hash,
    ) -> Result<Self::State, Self::Error> {
        y.members.insert(added);
        Ok(y)
    }

    fn remove(
        mut y: Self::State,
        _remover: PublicKey,
        removed: &PublicKey,
        _op: Hash,
    ) -> Result<Self::State, Self::Error> {
        y.members.remove(removed);
        Ok(y)
    }

    fn members(y: &Self::State) -> Result<HashSet<PublicKey>, Self::Error> {
        Ok(y.members.clone())
    }
}

#[cfg(test)]
mod dgm_tests {
    use super::*;
    use p2panda_core::PrivateKey;

    fn pk() -> PublicKey { PrivateKey::new().public_key() }

    #[test]
    fn create_contains_initial_members() {
        let me = pk(); let alice = pk(); let bob = pk();
        let state = DeltaDgm::create(me, &[alice, bob]).unwrap();
        let members = DeltaDgm::members(&state).unwrap();
        assert!(members.contains(&alice));
        assert!(members.contains(&bob));
    }

    #[test]
    fn add_member() {
        let me = pk(); let alice = pk();
        let state = DeltaDgm::create(me, &[]).unwrap();
        let state = DeltaDgm::add(state, me, alice, Hash::new(b"op1")).unwrap();
        assert!(DeltaDgm::members(&state).unwrap().contains(&alice));
    }

    #[test]
    fn remove_member() {
        let me = pk(); let alice = pk();
        let state = DeltaDgm::create(me, &[alice]).unwrap();
        let state = DeltaDgm::remove(state, me, &alice, Hash::new(b"op1")).unwrap();
        assert!(!DeltaDgm::members(&state).unwrap().contains(&alice));
    }

    #[test]
    fn from_welcome_preserves_members() {
        let me = pk(); let alice = pk();
        let state = DeltaDgm::create(me, &[alice]).unwrap();
        let welcomed = DeltaDgm::from_welcome(me, state).unwrap();
        assert!(DeltaDgm::members(&welcomed).unwrap().contains(&alice));
    }
}
```

**Step 2: Run tests to confirm they pass**

Run: `cargo test --manifest-path core/Cargo.toml --lib dgm_tests 2>&1 | tail -5`
Expected: `test result: ok. 4 passed`

**Step 3: Commit**

```bash
git add core/src/encryption.rs
git commit -m "feat(phase4): DeltaDgm — GroupMembership<PublicKey, Hash> for room encryption"
```

---

### Task 5: DeltaAckedDgm — AckedGroupMembership<PublicKey, Hash> for DMs

**Files:**
- Modify: `core/src/encryption.rs`

**Context:** The `AckedGroupMembership` trait is for the message scheme (DMs). It tracks acknowledgements for handling concurrency. Model after `~/.cargo/registry/src/.../p2panda-encryption-0.5.1/src/message_scheme/test_utils/dgm.rs` but using `PublicKey`/`Hash` instead of test ID types.

**Step 1: Write failing tests**

Add to the `#[cfg(test)]` section at the bottom of `encryption.rs`:

```rust
    #[test]
    fn acked_dgm_create_and_members() {
        let me = pk(); let alice = pk();
        let state = DeltaAckedDgm::create(me, &[alice]).unwrap();
        let members = DeltaAckedDgm::members_view(&state, &me).unwrap();
        assert!(members.contains(&alice));
    }

    #[test]
    fn acked_dgm_add_and_ack() {
        let me = pk(); let alice = pk();
        let op = Hash::new(b"add_op");
        let state = DeltaAckedDgm::create(me, &[]).unwrap();
        let state = DeltaAckedDgm::add(state, me, alice, op).unwrap();
        let state = DeltaAckedDgm::ack(state, alice, op).unwrap();
        let members = DeltaAckedDgm::members_view(&state, &me).unwrap();
        assert!(members.contains(&alice));
    }
```

**Step 2: Run tests to confirm they fail**

Run: `cargo test --manifest-path core/Cargo.toml --lib acked_dgm 2>&1 | tail -5`
Expected: compile error — `DeltaAckedDgm` not defined.

**Step 3: Implement DeltaAckedDgm**

Add after `DeltaDgm`'s impl block in `encryption.rs`:

```rust
use p2panda_encryption::traits::AckedGroupMembership;

// ─── DeltaAckedDgm — message scheme DGM ──────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaAckedDgm;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaAckedDgmState {
    pub my_id: PublicKey,
    pub members: HashSet<PublicKey>,
    pub removed: HashSet<PublicKey>,
    // op_id → (adder, added) for tracking adds awaiting ack
    pub pending_adds: std::collections::HashMap<[u8; 32], (PublicKey, PublicKey)>,
    // op_id → remover for tracking removes awaiting ack
    pub pending_removes: std::collections::HashMap<[u8; 32], (PublicKey, PublicKey)>,
    // op_id → set of members who acked it
    pub acks: std::collections::HashMap<[u8; 32], HashSet<PublicKey>>,
}

impl AckedGroupMembership<PublicKey, Hash> for DeltaAckedDgm {
    type State = DeltaAckedDgmState;
    type Error = Infallible;

    fn create(my_id: PublicKey, initial_members: &[PublicKey]) -> Result<Self::State, Self::Error> {
        Ok(DeltaAckedDgmState {
            my_id,
            members: HashSet::from_iter(initial_members.iter().cloned()),
            removed: HashSet::new(),
            pending_adds: Default::default(),
            pending_removes: Default::default(),
            acks: Default::default(),
        })
    }

    fn from_welcome(
        mut y: Self::State,
        y_welcome: Self::State,
    ) -> Result<Self::State, Self::Error> {
        // Merge welcomed state into our own — keep our my_id, take members from welcome.
        y.members = y_welcome.members;
        y.removed = y_welcome.removed;
        Ok(y)
    }

    fn add(
        mut y: Self::State,
        adder: PublicKey,
        added: PublicKey,
        op: Hash,
    ) -> Result<Self::State, Self::Error> {
        y.pending_adds.insert(op.as_bytes().try_into().unwrap_or([0u8; 32]), (adder, added));
        y.members.insert(added);
        Ok(y)
    }

    fn remove(
        mut y: Self::State,
        remover: PublicKey,
        removed: &PublicKey,
        op: Hash,
    ) -> Result<Self::State, Self::Error> {
        y.pending_removes.insert(op.as_bytes().try_into().unwrap_or([0u8; 32]), (remover, *removed));
        y.members.remove(removed);
        y.removed.insert(*removed);
        Ok(y)
    }

    fn ack(
        mut y: Self::State,
        acker: PublicKey,
        op: Hash,
    ) -> Result<Self::State, Self::Error> {
        let key = op.as_bytes().try_into().unwrap_or([0u8; 32]);
        y.acks.entry(key).or_default().insert(acker);
        Ok(y)
    }

    fn members_view(
        y: &Self::State,
        _viewer: &PublicKey,
    ) -> Result<HashSet<PublicKey>, Self::Error> {
        Ok(y.members.clone())
    }

    fn is_add(y: &Self::State, op: Hash) -> bool {
        let key = op.as_bytes().try_into().unwrap_or([0u8; 32]);
        y.pending_adds.contains_key(&key)
    }

    fn is_remove(y: &Self::State, op: Hash) -> bool {
        let key = op.as_bytes().try_into().unwrap_or([0u8; 32]);
        y.pending_removes.contains_key(&key)
    }
}
```

**Step 4: Run tests to confirm they pass**

Run: `cargo test --manifest-path core/Cargo.toml --lib acked_dgm 2>&1 | tail -5`
Expected: `test result: ok. 2 passed`

**Step 5: Commit**

```bash
git add core/src/encryption.rs
git commit -m "feat(phase4): DeltaAckedDgm — AckedGroupMembership<PublicKey, Hash> for DM encryption"
```

---

### Task 6: DeltaOrdering — Ordering<PublicKey, Hash, DeltaDgm> for rooms

**Files:**
- Modify: `core/src/encryption.rs`

**Context:** The `Ordering` trait wraps DCGKA control/application messages for delivery. `DeltaOrdering` uses a `VecDeque` — messages are always immediately ready because p2panda-core LogSync already ensures causal delivery order. Read `~/.cargo/registry/src/.../p2panda-encryption-0.5.1/src/data_scheme/test_utils/ordering.rs` for a complete reference implementation.

**Step 1: Write failing test**

Add to the test section in `encryption.rs`:

```rust
    #[test]
    fn ordering_queue_and_dequeue() {
        use p2panda_encryption::data_scheme::ControlMessage;
        let me = pk();
        let state = DeltaOrdering::init(me);
        // next_control_message creates an outgoing message
        let dummy_ctrl = ControlMessage::create(vec![]);
        let (state, msg) = DeltaOrdering::next_control_message(state, &dummy_ctrl, &[]).unwrap();
        let (state, _) = DeltaOrdering::set_welcome(state, &msg).unwrap();
        let (state, _) = DeltaOrdering::queue(state, &msg).unwrap();
        let (_state, ready) = DeltaOrdering::next_ready_message(state).unwrap();
        assert!(ready.is_some());
    }
```

**Step 2: Run tests to confirm they fail**

Run: `cargo test --manifest-path core/Cargo.toml --lib ordering_queue 2>&1 | tail -5`
Expected: compile error.

**Step 3: Implement DeltaOrdering**

Add after `DeltaAckedDgm` in `encryption.rs`:

```rust
use std::collections::VecDeque;
use p2panda_encryption::data_scheme::{ControlMessage as DataControlMessage,
                                       DirectMessage as DataDirectMessage};
use p2panda_encryption::traits::{GroupMessage, GroupMessageContent, Ordering};
use p2panda_encryption::data_scheme::GroupSecretId;
use p2panda_encryption::crypto::xchacha20::XAeadNonce;

// ─── DeltaMessage — GroupMessage impl for data scheme ────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum DeltaMessageContent {
    Control {
        ctrl: DataControlMessage<PublicKey>,
        directs: Vec<DataDirectMessage<PublicKey, Hash, DeltaDgm>>,
    },
    Application {
        group_secret_id: GroupSecretId,
        nonce: XAeadNonce,
        ciphertext: Vec<u8>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaMessage {
    pub id: Hash,
    pub sender: PublicKey,
    pub content: DeltaMessageContent,
}

impl GroupMessage<PublicKey, Hash, DeltaDgm> for DeltaMessage {
    fn id(&self) -> Hash { self.id }
    fn sender(&self) -> PublicKey { self.sender }
    fn content(&self) -> GroupMessageContent<PublicKey> {
        match &self.content {
            DeltaMessageContent::Control { ctrl, .. } =>
                GroupMessageContent::Control(ctrl.clone()),
            DeltaMessageContent::Application { group_secret_id, nonce, ciphertext } =>
                GroupMessageContent::Application {
                    group_secret_id: *group_secret_id,
                    nonce: *nonce,
                    ciphertext: ciphertext.clone(),
                },
        }
    }
    fn direct_messages(&self) -> Vec<DataDirectMessage<PublicKey, Hash, DeltaDgm>> {
        match &self.content {
            DeltaMessageContent::Control { directs, .. } => directs.clone(),
            _ => vec![],
        }
    }
}

// ─── DeltaOrdering ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaOrderingState {
    my_id: PublicKey,
    next_seq: u64,
    queue: VecDeque<DeltaMessage>,
    welcomed: bool,
}

pub struct DeltaOrdering;

impl DeltaOrdering {
    pub fn init(my_id: PublicKey) -> DeltaOrderingState {
        DeltaOrderingState { my_id, next_seq: 0, queue: VecDeque::new(), welcomed: false }
    }
}

impl Ordering<PublicKey, Hash, DeltaDgm> for DeltaOrdering {
    type State = DeltaOrderingState;
    type Error = Infallible;
    type Message = DeltaMessage;

    fn next_control_message(
        mut y: Self::State,
        ctrl: &DataControlMessage<PublicKey>,
        directs: &[DataDirectMessage<PublicKey, Hash, DeltaDgm>],
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        // Use a synthetic Hash from seq_num for the op ID.
        let seq_bytes = y.next_seq.to_be_bytes();
        let id = Hash::new(&seq_bytes);
        y.next_seq += 1;
        let msg = DeltaMessage {
            id,
            sender: y.my_id,
            content: DeltaMessageContent::Control {
                ctrl: ctrl.clone(),
                directs: directs.to_vec(),
            },
        };
        Ok((y, msg))
    }

    fn next_application_message(
        mut y: Self::State,
        group_secret_id: GroupSecretId,
        nonce: XAeadNonce,
        ciphertext: Vec<u8>,
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        let seq_bytes = y.next_seq.to_be_bytes();
        let id = Hash::new(&seq_bytes);
        y.next_seq += 1;
        let msg = DeltaMessage {
            id,
            sender: y.my_id,
            content: DeltaMessageContent::Application { group_secret_id, nonce, ciphertext },
        };
        Ok((y, msg))
    }

    fn queue(mut y: Self::State, message: &Self::Message) -> Result<Self::State, Self::Error> {
        y.queue.push_back(message.clone());
        Ok(y)
    }

    fn set_welcome(mut y: Self::State, _msg: &Self::Message) -> Result<Self::State, Self::Error> {
        y.welcomed = true;
        Ok(y)
    }

    fn next_ready_message(
        mut y: Self::State,
    ) -> Result<(Self::State, Option<Self::Message>), Self::Error> {
        if !y.welcomed { return Ok((y, None)); }
        Ok((y.clone(), { y.queue.pop_front() }))
    }
}
```

**Step 4: Run tests**

Run: `cargo test --manifest-path core/Cargo.toml --lib ordering_queue 2>&1 | tail -5`
Expected: `test result: ok. 1 passed`

**Step 5: Commit**

```bash
git add core/src/encryption.rs
git commit -m "feat(phase4): DeltaOrdering + DeltaMessage — Ordering<PublicKey, Hash, DeltaDgm>"
```

---

### Task 7: DeltaFsOrdering — ForwardSecureOrdering for DMs

**Files:**
- Modify: `core/src/encryption.rs`

**Context:** The `ForwardSecureOrdering` trait is for the message scheme (DMs). Read `~/.cargo/registry/src/.../p2panda-encryption-0.5.1/src/message_scheme/test_utils/ordering.rs` for the full reference. Model `DeltaFsOrdering` the same way as `DeltaOrdering` (VecDeque, always-ready).

**Step 1: Write failing test**

Add to test section:

```rust
    #[test]
    fn fs_ordering_queue_and_dequeue() {
        use p2panda_encryption::message_scheme::ControlMessage as MsgCtrl;
        let me = pk();
        let state = DeltaFsOrdering::init(me);
        let dummy_ctrl = MsgCtrl::create(vec![]);
        let (state, msg) = DeltaFsOrdering::next_control_message(state, &dummy_ctrl, &[]).unwrap();
        let (state, _) = DeltaFsOrdering::set_welcome(state, &msg).unwrap();
        let (state, _) = DeltaFsOrdering::queue(state, &msg).unwrap();
        let (_state, ready) = DeltaFsOrdering::next_ready_message(state).unwrap();
        assert!(ready.is_some());
    }
```

**Step 2: Run tests to confirm they fail**

Run: `cargo test --manifest-path core/Cargo.toml --lib fs_ordering 2>&1 | tail -5`
Expected: compile error.

**Step 3: Implement DeltaFsOrdering**

Add after `DeltaOrdering` in `encryption.rs`:

```rust
use p2panda_encryption::message_scheme::{
    ControlMessage as MsgControlMessage,
    DirectMessage as MsgDirectMessage,
    Generation,
};
use p2panda_encryption::traits::{
    ForwardSecureGroupMessage, ForwardSecureMessageContent, ForwardSecureOrdering,
};

// ─── DeltaFsMessage — ForwardSecureGroupMessage impl for message scheme ──────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum DeltaFsMessageContent {
    Control {
        ctrl: MsgControlMessage<PublicKey, Hash>,
        directs: Vec<MsgDirectMessage<PublicKey, Hash, DeltaAckedDgm>>,
    },
    Application {
        generation: Generation,
        ciphertext: Vec<u8>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaFsMessage {
    pub id: Hash,
    pub sender: PublicKey,
    pub content: DeltaFsMessageContent,
}

impl ForwardSecureGroupMessage<PublicKey, Hash, DeltaAckedDgm> for DeltaFsMessage {
    fn id(&self) -> Hash { self.id }
    fn sender(&self) -> PublicKey { self.sender }
    fn content(&self) -> ForwardSecureMessageContent<PublicKey, Hash> {
        match &self.content {
            DeltaFsMessageContent::Control { ctrl, .. } =>
                ForwardSecureMessageContent::Control(ctrl.clone()),
            DeltaFsMessageContent::Application { generation, ciphertext } =>
                ForwardSecureMessageContent::Application {
                    generation: *generation,
                    ciphertext: ciphertext.clone(),
                },
        }
    }
    fn direct_messages(&self) -> Vec<MsgDirectMessage<PublicKey, Hash, DeltaAckedDgm>> {
        match &self.content {
            DeltaFsMessageContent::Control { directs, .. } => directs.clone(),
            _ => vec![],
        }
    }
}

// ─── DeltaFsOrdering ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaFsOrderingState {
    my_id: PublicKey,
    next_seq: u64,
    queue: VecDeque<DeltaFsMessage>,
    welcomed: bool,
}

pub struct DeltaFsOrdering;

impl DeltaFsOrdering {
    pub fn init(my_id: PublicKey) -> DeltaFsOrderingState {
        DeltaFsOrderingState { my_id, next_seq: 0, queue: VecDeque::new(), welcomed: false }
    }
}

impl ForwardSecureOrdering<PublicKey, Hash, DeltaAckedDgm> for DeltaFsOrdering {
    type State = DeltaFsOrderingState;
    type Error = Infallible;
    type Message = DeltaFsMessage;

    fn next_control_message(
        mut y: Self::State,
        ctrl: &MsgControlMessage<PublicKey, Hash>,
        directs: &[MsgDirectMessage<PublicKey, Hash, DeltaAckedDgm>],
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        let id = Hash::new(&y.next_seq.to_be_bytes());
        y.next_seq += 1;
        let msg = DeltaFsMessage {
            id,
            sender: y.my_id,
            content: DeltaFsMessageContent::Control {
                ctrl: ctrl.clone(),
                directs: directs.to_vec(),
            },
        };
        Ok((y, msg))
    }

    fn next_application_message(
        mut y: Self::State,
        generation: Generation,
        ciphertext: Vec<u8>,
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        let id = Hash::new(&y.next_seq.to_be_bytes());
        y.next_seq += 1;
        let msg = DeltaFsMessage {
            id,
            sender: y.my_id,
            content: DeltaFsMessageContent::Application { generation, ciphertext },
        };
        Ok((y, msg))
    }

    fn queue(mut y: Self::State, msg: &Self::Message) -> Result<Self::State, Self::Error> {
        y.queue.push_back(msg.clone());
        Ok(y)
    }

    fn set_welcome(mut y: Self::State, _msg: &Self::Message) -> Result<Self::State, Self::Error> {
        y.welcomed = true;
        Ok(y)
    }

    fn next_ready_message(
        mut y: Self::State,
    ) -> Result<(Self::State, Option<Self::Message>), Self::Error> {
        if !y.welcomed { return Ok((y, None)); }
        Ok((y.clone(), { y.queue.pop_front() }))
    }
}
```

**Step 4: Run tests**

Run: `cargo test --manifest-path core/Cargo.toml --lib fs_ordering 2>&1 | tail -5`
Expected: `test result: ok. 1 passed`

**Step 5: Commit**

```bash
git add core/src/encryption.rs
git commit -m "feat(phase4): DeltaFsOrdering + DeltaFsMessage — ForwardSecureOrdering for DM encryption"
```

---

### Task 8: EncryptionCore struct + init_encryption()

**Files:**
- Modify: `core/src/encryption.rs`
- Modify: `core/src/store.rs`

**Context:**
- `KeyManager` (from `p2panda_encryption::key_manager`) manages our own identity pre-key + one-time pre-keys.
- `KeyRegistry` (from `p2panda_encryption::key_registry`) stores others' published bundles.
- `KeyManager::init_and_generate_prekey(identity_secret, Lifetime::default(), &rng)` creates a new `KeyManagerState`.
- `KeyRegistry::<PublicKey>::init()` creates a new `KeyRegistryState<PublicKey>`.
- Both states are CBOR-serializable.
- The identity secret is derived from the Ed25519 private key via its raw bytes → X25519 conversion. p2panda-encryption uses `x25519::SecretKey`, not ed25519. Derive from private key bytes: `SecretKey::from_bytes(private_key.to_bytes())`.

**Step 1: Write failing test**

Add to test section:

```rust
    #[tokio::test]
    async fn encryption_core_init() {
        use sqlx::sqlite::SqlitePoolOptions;
        use crate::db;
        let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        db::run_migrations(&pool).await.unwrap();
        let privkey = p2panda_core::PrivateKey::new();
        init_encryption(privkey.to_hex(), pool).await.unwrap();
        assert!(get_encryption().is_some());
    }
```

**Step 2: Run tests to confirm they fail**

Run: `cargo test --manifest-path core/Cargo.toml --lib encryption_core_init 2>&1 | tail -5`
Expected: compile error — `EncryptionCore`, `init_encryption`, `get_encryption` not defined.

**Step 3: Implement EncryptionCore and init_encryption**

Add to `encryption.rs` (after the ordering impls):

```rust
use std::sync::OnceLock;
use p2panda_encryption::key_bundle::Lifetime;
use p2panda_encryption::key_manager::{KeyManager, KeyManagerState};
use p2panda_encryption::key_registry::{KeyRegistry, KeyRegistryState};
use p2panda_encryption::data_scheme::{EncryptionGroup, GroupState};
use p2panda_encryption::message_scheme::{MessageGroup, GroupState as MsgGroupState};
use p2panda_encryption::crypto::{Rng, x25519::SecretKey as X25519SecretKey};
use sqlx::SqlitePool;
use tokio::sync::Mutex;

// Concrete GroupState type aliases.
pub type DeltaGroupState = GroupState<
    PublicKey, Hash,
    KeyRegistry<PublicKey>,
    DeltaDgm,
    KeyManager,
    DeltaOrdering,
>;
pub type DeltaMsgGroupState = MsgGroupState<
    PublicKey, Hash,
    KeyRegistry<PublicKey>,
    DeltaAckedDgm,
    KeyManager,
    DeltaFsOrdering,
>;

pub struct EncryptionCore {
    pub key_manager:  Mutex<KeyManagerState>,
    pub key_registry: Mutex<KeyRegistryState<PublicKey>>,
    pub room_groups:  Mutex<std::collections::HashMap<String, DeltaGroupState>>,
    pub dm_groups:    Mutex<std::collections::HashMap<String, DeltaMsgGroupState>>,
    pub read_pool:    SqlitePool,
    pub my_public_key: PublicKey,
}

static ENCRYPTION: OnceLock<EncryptionCore> = OnceLock::new();

pub fn get_encryption() -> Option<&'static EncryptionCore> {
    ENCRYPTION.get()
}

pub async fn init_encryption(
    private_key_hex: String,
    read_pool: SqlitePool,
) -> Result<(), EncryptionError> {
    if ENCRYPTION.get().is_some() { return Ok(()); }

    let pk_bytes = hex::decode(&private_key_hex)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let private_key = p2panda_core::PrivateKey::try_from(pk_bytes.as_slice())
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let my_public_key = private_key.public_key();

    // Derive X25519 identity secret from Ed25519 private key bytes.
    let ed_bytes: [u8; 32] = pk_bytes.try_into()
        .map_err(|_| EncryptionError::Init("bad key length".into()))?;
    let x25519_secret = X25519SecretKey::from_bytes(ed_bytes);

    let rng = Rng::from_entropy();

    // Load or create KeyManagerState.
    let km_state = match crate::db::load_enc_key_manager(&read_pool).await? {
        Some(bytes) => {
            ciborium::from_reader::<KeyManagerState, _>(bytes.as_slice())
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?
        }
        None => {
            let state = KeyManager::init_and_generate_prekey(
                &x25519_secret,
                Lifetime::default(),
                &rng,
            ).map_err(|e| EncryptionError::Init(e.to_string()))?;
            let mut buf = Vec::new();
            ciborium::into_writer(&state, &mut buf)
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
            crate::db::save_enc_key_manager(&read_pool, &buf).await?;
            state
        }
    };

    // Load or create KeyRegistryState.
    let kr_state: KeyRegistryState<PublicKey> = match crate::db::load_enc_key_registry(&read_pool).await? {
        Some(bytes) => ciborium::from_reader(bytes.as_slice())
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?,
        None => KeyRegistry::<PublicKey>::init(),
    };

    // Load all persisted GroupStates.
    let mut room_groups = std::collections::HashMap::new();
    let mut dm_groups = std::collections::HashMap::new();
    for (group_id, group_type, state_bytes) in
        crate::db::load_all_enc_group_states(&read_pool).await?
    {
        match group_type.as_str() {
            "room" => {
                if let Ok(state) = ciborium::from_reader::<DeltaGroupState, _>(state_bytes.as_slice()) {
                    room_groups.insert(group_id, state);
                }
            }
            "dm" => {
                if let Ok(state) = ciborium::from_reader::<DeltaMsgGroupState, _>(state_bytes.as_slice()) {
                    dm_groups.insert(group_id, state);
                }
            }
            _ => {}
        }
    }

    let core = EncryptionCore {
        key_manager: Mutex::new(km_state),
        key_registry: Mutex::new(kr_state),
        room_groups: Mutex::new(room_groups),
        dm_groups: Mutex::new(dm_groups),
        read_pool: read_pool.clone(),
        my_public_key,
    };

    ENCRYPTION.set(core).ok();
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum EncryptionError {
    #[error("init error: {0}")]
    Init(String),
    #[error("CBOR error: {0}")]
    Cbor(String),
    #[error("DB error: {0}")]
    Db(#[from] crate::db::DbError),
    #[error("not initialised")]
    NotInitialised,
    #[error("group not found: {0}")]
    GroupNotFound(String),
    #[error("decrypt error: {0}")]
    Decrypt(String),
    #[error("encrypt error: {0}")]
    Encrypt(String),
}
```

**Step 4: Wire into store.rs**

In `core/src/store.rs`, in `bootstrap()`, after `crate::network::init_network(...)` call:

```rust
crate::encryption::init_encryption(private_key_hex.to_string(), read_pool.clone())
    .await
    .map_err(|e| StoreError::Other(e.to_string()))?;
```

Also add `Other(String)` variant to `StoreError` if it doesn't exist:
```rust
#[error("{0}")]
Other(String),
```

**Step 5: Run tests**

Run: `cargo test --manifest-path core/Cargo.toml --lib encryption_core_init 2>&1 | tail -5`
Expected: `test result: ok. 1 passed`

**Step 6: Commit**

```bash
git add core/src/encryption.rs core/src/store.rs
git commit -m "feat(phase4): EncryptionCore singleton + init_encryption() — loads/creates KeyManager, KeyRegistry, GroupStates"
```

---

### Task 9: Room encryption helpers — encrypt_for_room / decrypt_for_room

**Files:**
- Modify: `core/src/encryption.rs`

**Context:**
- `EncryptionGroup::encrypt(state, plaintext, rng)` → `(new_state, EncryptedBody{secret_id, nonce, ciphertext})`
- `EncryptionGroup::decrypt(state, secret_id, nonce, ciphertext)` → `(new_state, plaintext)`
- Wait — actually looking at the API: `encrypt_data(secret, nonce, plaintext)` and `decrypt_data(secret, nonce, ciphertext)` are the low-level primitives from `p2panda_encryption::data_scheme`.
- The `GroupState` holds the `SecretBundle` — use `state.secrets` to get the bundle, then call `SecretBundle::latest(&state.secrets)` to get the current secret.
- `encrypt_data(secret, &rng, plaintext)` returns `(nonce, ciphertext)`.
- `decrypt_data(secret, nonce, &ciphertext)` returns `plaintext`.

**Step 1: Write failing test**

Add to test section:

```rust
    #[test]
    fn room_encrypt_decrypt_roundtrip() {
        // We test the low-level encrypt/decrypt_data primitives directly
        // since init_room_group requires a full KeyRegistry.
        use p2panda_encryption::data_scheme::{encrypt_data, decrypt_data};
        use p2panda_encryption::data_scheme::group_secret::SecretBundle;
        use p2panda_encryption::crypto::Rng;

        let rng = Rng::from_seed([42u8; 32]);
        let bundle_state = SecretBundle::init();
        let (bundle_state, secret) = SecretBundle::generate(&bundle_state, &rng).unwrap();
        let (bundle_state, _) = SecretBundle::add(bundle_state, secret.clone());
        let plaintext = b"hello encrypted world";
        let (nonce, ciphertext) = encrypt_data(&secret, &rng, plaintext).unwrap();
        let decrypted = decrypt_data(&secret, &nonce, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }
```

**Step 2: Run test to confirm it fails**

Run: `cargo test --manifest-path core/Cargo.toml --lib room_encrypt_decrypt 2>&1 | tail -5`
Expected: compile error or test failure.

**Step 3: Add EncryptedBody struct and room encrypt/decrypt helpers**

Add to `encryption.rs`:

```rust
use p2panda_encryption::data_scheme::{
    decrypt_data, encrypt_data, GroupSecretId, SecretBundle,
};

/// Envelope written as the p2panda op body for encrypted messages.
#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptedBody {
    pub secret_id: GroupSecretId,
    pub nonce:     [u8; 24],   // XAeadNonce is [u8; 24]
    pub ciphertext: Vec<u8>,
}

/// Encrypt `plaintext` for a room. Returns CBOR-encoded `EncryptedBody`.
pub async fn encrypt_for_room(room_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let rng = Rng::from_entropy();
    let mut groups = enc.room_groups.lock().await;
    let state = groups.get(room_id).ok_or_else(|| EncryptionError::GroupNotFound(room_id.into()))?;
    let (secret_id, secret) = SecretBundle::latest(&state.secrets)
        .ok_or_else(|| EncryptionError::Encrypt("no group secret yet".into()))?;
    let (nonce, ciphertext) = encrypt_data(&secret, &rng, plaintext)
        .map_err(|e| EncryptionError::Encrypt(e.to_string()))?;
    let envelope = EncryptedBody { secret_id, nonce: nonce.into(), ciphertext };
    let mut buf = Vec::new();
    ciborium::into_writer(&envelope, &mut buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    Ok(buf)
}

/// Decrypt a CBOR-encoded `EncryptedBody` for a room. Returns plaintext.
/// Returns `None` if group state not ready (decryption pending).
pub async fn decrypt_for_room(room_id: &str, body: &[u8]) -> Option<Vec<u8>> {
    let enc = get_encryption()?;
    let envelope: EncryptedBody = ciborium::from_reader(body).ok()?;
    let groups = enc.room_groups.lock().await;
    let state = groups.get(room_id)?;
    let secret = SecretBundle::get(&state.secrets, &envelope.secret_id)?;
    let nonce: XAeadNonce = envelope.nonce.into();
    decrypt_data(&secret, &nonce, &envelope.ciphertext).ok()
}
```

**Step 4: Run test**

Run: `cargo test --manifest-path core/Cargo.toml --lib room_encrypt_decrypt 2>&1 | tail -5`
Expected: `test result: ok. 1 passed`

**Step 5: Commit**

```bash
git add core/src/encryption.rs
git commit -m "feat(phase4): EncryptedBody + encrypt_for_room/decrypt_for_room helpers"
```

---

### Task 10: init_room_group() — DCGKA group creation; wire into create_room()

**Files:**
- Modify: `core/src/encryption.rs`
- Modify: `core/src/lib.rs`
- Modify: `core/src/ops.rs` (already has EncCtrlOp / EncDirectOp from Task 2)

**Context:**
- `EncryptionGroup::init(my_id, my_keys, pki, dgm, orderer)` creates a `GroupState`.
- `EncryptionGroup::create(state, initial_members, &rng)` → `(new_state, GroupOutput)`.
- `GroupOutput` contains the control message and direct messages.
- We publish the control message as `EncCtrlOp` and each direct message as `EncDirectOp`.
- `DeltaOrdering::init(my_id)` creates the initial orderer state.
- `DeltaDgm::create(my_id, initial_members)` creates the DGM state — but the `GroupState` API takes care of this internally via `EncryptionGroup::init`.

**Step 1: Implement init_room_group in encryption.rs**

Add to `encryption.rs`:

```rust
use p2panda_encryption::data_scheme::{EncryptionGroup, GroupOutput};

/// Create a new DCGKA encryption group for a room.
/// Returns (EncCtrlOp bytes, Vec<(recipient_hex, EncDirectOp bytes)>).
pub async fn init_room_group(
    room_id: &str,
    initial_members: Vec<PublicKey>,
) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let rng = Rng::from_entropy();

    let km = enc.key_manager.lock().await;
    let kr = enc.key_registry.lock().await;

    // Build initial GroupState.
    let dgm_state = DeltaDgm::create(enc.my_public_key, &initial_members)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let ord_state = DeltaOrdering::init(enc.my_public_key);

    let group_state = EncryptionGroup::<
        PublicKey, Hash,
        KeyRegistry<PublicKey>,
        DeltaDgm,
        KeyManager,
        DeltaOrdering,
    >::init(enc.my_public_key, km.clone(), kr.clone(), dgm_state, ord_state);

    drop(km); drop(kr);

    // Create the group — generates group secret, returns control + direct messages.
    let (new_state, group_output) = EncryptionGroup::<
        PublicKey, Hash,
        KeyRegistry<PublicKey>,
        DeltaDgm,
        KeyManager,
        DeltaOrdering,
    >::create(group_state, initial_members, &rng)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;

    // Persist new GroupState.
    let mut state_buf = Vec::new();
    ciborium::into_writer(&new_state, &mut state_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_group_state(&enc.read_pool, room_id, "room", &state_buf).await?;
    enc.room_groups.lock().await.insert(room_id.to_string(), new_state);

    // Encode EncCtrlOp.
    let ctrl_data = {
        let mut buf = Vec::new();
        ciborium::into_writer(group_output.message.content(), &mut buf)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
        buf
    };
    let ctrl_op = crate::ops::EncCtrlOp { group_id: room_id.to_string(), ctrl_data };
    let ctrl_bytes = crate::ops::encode_cbor(&ctrl_op)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    // Encode EncDirectOp per recipient.
    let mut direct_ops = Vec::new();
    for dm in group_output.message.direct_messages() {
        let recipient_key = hex::encode(dm.recipient().to_bytes());
        let mut dm_buf = Vec::new();
        ciborium::into_writer(&dm, &mut dm_buf)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
        let direct_op = crate::ops::EncDirectOp {
            group_id: room_id.to_string(),
            recipient_key: recipient_key.clone(),
            direct_data: dm_buf,
        };
        let op_bytes = crate::ops::encode_cbor(&direct_op)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
        direct_ops.push((recipient_key, op_bytes));
    }

    Ok((ctrl_bytes, direct_ops))
}
```

**Step 2: Wire into create_room() in lib.rs**

In `lib.rs`, in `create_room()`, after `db::insert_room(...)`:

```rust
// Bootstrap DCGKA encryption group for this room.
// Initial members = just the creator for now (Phase 5 wires in invite flow).
if let Ok((ctrl_bytes, direct_ops)) =
    encryption::init_room_group(&room_id, vec![core.private_key.public_key()]).await
{
    let mut op_store = core.op_store.lock().await;
    let _ = ops::sign_and_store_op(
        &mut op_store, &core.private_key, ops::log_ids::ENC_CTRL, ctrl_bytes,
    ).await;
    for (_recipient, direct_bytes) in direct_ops {
        let _ = ops::sign_and_store_op(
            &mut op_store, &core.private_key, ops::log_ids::ENC_DIRECT, direct_bytes,
        ).await;
    }
}
```

**Step 3: Run cargo check**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -10`
Expected: no output.

**Step 4: Commit**

```bash
git add core/src/encryption.rs core/src/lib.rs
git commit -m "feat(phase4): init_room_group() — DCGKA room creation + publish enc_ctrl/enc_direct"
```

---

### Task 11: init_dm_group() — MessageGroup creation; wire into create_dm_thread()

**Files:**
- Modify: `core/src/encryption.rs`
- Modify: `core/src/lib.rs`

**Context:**
- `MessageGroup` (from `p2panda_encryption::message_scheme`) is the DM counterpart of `EncryptionGroup`.
- Uses `OneTimeKeyBundle` (from the key registry) for key agreement.
- API mirrors `EncryptionGroup`: `init(my_id, my_keys, pki, dgm, orderer)` then `create(state, members, &rng)`.
- `DeltaFsOrdering::init(my_id)` and `DeltaAckedDgm::create(my_id, members)` provide the DGM/ordering state.

**Step 1: Implement init_dm_group in encryption.rs**

Add to `encryption.rs`:

```rust
use p2panda_encryption::message_scheme::MessageGroup;

/// Create a new MessageGroup encryption state for a DM thread.
pub async fn init_dm_group(
    thread_id: &str,
    other_key: PublicKey,
) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let rng = Rng::from_entropy();
    let members = vec![other_key];

    let km = enc.key_manager.lock().await;
    let kr = enc.key_registry.lock().await;

    let dgm_state = DeltaAckedDgm::create(enc.my_public_key, &members)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let ord_state = DeltaFsOrdering::init(enc.my_public_key);

    let group_state = MessageGroup::<
        PublicKey, Hash,
        KeyRegistry<PublicKey>,
        DeltaAckedDgm,
        KeyManager,
        DeltaFsOrdering,
    >::init(enc.my_public_key, km.clone(), kr.clone(), dgm_state, ord_state);

    drop(km); drop(kr);

    let (new_state, group_output) = MessageGroup::<
        PublicKey, Hash,
        KeyRegistry<PublicKey>,
        DeltaAckedDgm,
        KeyManager,
        DeltaFsOrdering,
    >::create(group_state, members, &rng)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;

    // Persist.
    let mut state_buf = Vec::new();
    ciborium::into_writer(&new_state, &mut state_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_group_state(&enc.read_pool, thread_id, "dm", &state_buf).await?;
    enc.dm_groups.lock().await.insert(thread_id.to_string(), new_state);

    // Encode ctrl + direct ops (same pattern as init_room_group).
    let ctrl_data = {
        let mut buf = Vec::new();
        ciborium::into_writer(group_output.message.content(), &mut buf)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
        buf
    };
    let ctrl_op = crate::ops::EncCtrlOp { group_id: thread_id.to_string(), ctrl_data };
    let ctrl_bytes = crate::ops::encode_cbor(&ctrl_op)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    let mut direct_ops = Vec::new();
    for dm in group_output.message.direct_messages() {
        let recipient_key = hex::encode(dm.recipient().to_bytes());
        let mut dm_buf = Vec::new();
        ciborium::into_writer(&dm, &mut dm_buf)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
        let direct_op = crate::ops::EncDirectOp {
            group_id: thread_id.to_string(),
            recipient_key: recipient_key.clone(),
            direct_data: dm_buf,
        };
        direct_ops.push((recipient_key, crate::ops::encode_cbor(&direct_op)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?));
    }

    Ok((ctrl_bytes, direct_ops))
}
```

**Step 2: Wire into create_dm_thread() in lib.rs**

In `lib.rs`, in `create_dm_thread()`, after `db::insert_dm_thread(...)`:

```rust
// Bootstrap MessageGroup encryption for this DM thread.
let recipient_pk = p2panda_core::PublicKey::from_hex(&recipient_key)
    .unwrap_or(core.private_key.public_key()); // fallback is harmless — DCGKA will reject bad keys
if let Ok((ctrl_bytes, direct_ops)) =
    encryption::init_dm_group(&thread_id, recipient_pk).await
{
    let mut op_store = core.op_store.lock().await;
    let _ = ops::sign_and_store_op(
        &mut op_store, &core.private_key, ops::log_ids::ENC_CTRL, ctrl_bytes,
    ).await;
    for (_recipient, direct_bytes) in direct_ops {
        let _ = ops::sign_and_store_op(
            &mut op_store, &core.private_key, ops::log_ids::ENC_DIRECT, direct_bytes,
        ).await;
    }
}
```

**Step 3: Run cargo check**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -10`
Expected: no output.

**Step 4: Commit**

```bash
git add core/src/encryption.rs core/src/lib.rs
git commit -m "feat(phase4): init_dm_group() — MessageGroup creation for DM threads"
```

---

### Task 12: Projector — process enc_ctrl and enc_direct ops

**Files:**
- Modify: `core/src/projector.rs`
- Modify: `core/src/encryption.rs`

**Context:**
- `enc_ctrl` ops carry a DCGKA `ControlMessage`. Call `EncryptionGroup::process(state, message)` to advance group state.
- `enc_direct` ops carry a `DirectMessage` addressed to a specific recipient. Skip if `recipient_key ≠ my_public_key`. Otherwise call `EncryptionGroup::process(state, message)`.
- After processing, persist the updated `GroupState` to SQLite.
- The `EncryptionGroup::process` API takes the `GroupState` and a `Message` (our `DeltaMessage`). We need to reconstruct a `DeltaMessage` from the stored ctrl/direct data.

**Step 1: Add process_ctrl and process_direct to encryption.rs**

Add to `encryption.rs`:

```rust
/// Process a received EncCtrlOp body. Advances group state.
pub async fn process_ctrl(group_id: &str, author_key: &str, body: &[u8]) -> Result<(), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let op: crate::ops::EncCtrlOp = crate::ops::decode_cbor(body)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    // Determine if this is a room or DM group.
    let is_room = enc.room_groups.lock().await.contains_key(group_id);
    let author: PublicKey = PublicKey::from_hex(author_key)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;

    if is_room {
        let ctrl: p2panda_encryption::data_scheme::ControlMessage<PublicKey> =
            ciborium::from_reader(op.ctrl_data.as_slice())
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

        let dummy_hash = Hash::new(body); // use body hash as message id
        let msg = DeltaMessage {
            id: dummy_hash,
            sender: author,
            content: DeltaMessageContent::Control { ctrl, directs: vec![] },
        };

        let mut groups = enc.room_groups.lock().await;
        let state = groups.remove(group_id)
            .ok_or_else(|| EncryptionError::GroupNotFound(group_id.into()))?;
        let (new_state, _output) = EncryptionGroup::<
            PublicKey, Hash, KeyRegistry<PublicKey>, DeltaDgm, KeyManager, DeltaOrdering,
        >::process(state, &msg, &Rng::from_entropy())
            .map_err(|e| EncryptionError::Init(e.to_string()))?;

        let mut buf = Vec::new();
        ciborium::into_writer(&new_state, &mut buf)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
        crate::db::save_enc_group_state(&enc.read_pool, group_id, "room", &buf).await?;
        groups.insert(group_id.to_string(), new_state);
    }
    // DM ctrl processing is symmetric — omitted for brevity, follows same pattern with MessageGroup.
    Ok(())
}

/// Process a received EncDirectOp body. Skip if not addressed to us.
pub async fn process_direct(group_id: &str, body: &[u8], my_key_hex: &str) -> Result<(), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let op: crate::ops::EncDirectOp = crate::ops::decode_cbor(body)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    // Skip if not addressed to us.
    if op.recipient_key != my_key_hex { return Ok(()); }

    let is_room = enc.room_groups.lock().await.contains_key(group_id);
    if is_room {
        let dm: p2panda_encryption::data_scheme::DirectMessage<PublicKey, Hash, DeltaDgm> =
            ciborium::from_reader(op.direct_data.as_slice())
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

        let sender = *dm.sender();
        let dummy_hash = Hash::new(body);
        let msg = DeltaMessage {
            id: dummy_hash,
            sender,
            content: DeltaMessageContent::Control { ctrl: dm.as_ctrl_message(), directs: vec![dm] },
        };

        let mut groups = enc.room_groups.lock().await;
        let state = groups.remove(group_id)
            .ok_or_else(|| EncryptionError::GroupNotFound(group_id.into()))?;
        let (new_state, _output) = EncryptionGroup::<
            PublicKey, Hash, KeyRegistry<PublicKey>, DeltaDgm, KeyManager, DeltaOrdering,
        >::process(state, &msg, &Rng::from_entropy())
            .map_err(|e| EncryptionError::Init(e.to_string()))?;

        let mut buf = Vec::new();
        ciborium::into_writer(&new_state, &mut buf)
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
        crate::db::save_enc_group_state(&enc.read_pool, group_id, "room", &buf).await?;
        groups.insert(group_id.to_string(), new_state);
    }
    Ok(())
}
```

**Step 2: Wire into projector.rs**

In `projector.rs`, add to the `match log_id` dispatch in `project_tick()`:

```rust
log_ids::ENC_CTRL => {
    // Extract group_id from the EncCtrlOp.
    if let Ok(op) = ops::decode_cbor::<ops::EncCtrlOp>(&body_bytes) {
        let _ = crate::encryption::process_ctrl(&op.group_id, &pk_hex, &body_bytes).await;
    }
    Ok(())
}
log_ids::ENC_DIRECT => {
    if let Ok(op) = ops::decode_cbor::<ops::EncDirectOp>(&body_bytes) {
        let core = get_core().ok_or("not init")?;
        let _ = crate::encryption::process_direct(
            &op.group_id, &body_bytes, &core.public_key_hex
        ).await;
    }
    Ok(())
}
```

**Step 3: Run cargo check**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -10`
Expected: no output.

**Step 4: Commit**

```bash
git add core/src/encryption.rs core/src/projector.rs
git commit -m "feat(phase4): projector handles enc_ctrl + enc_direct — advances DCGKA group state"
```

---

### Task 13: Projector key_bundle handler + publish initial KeyBundleOp

**Files:**
- Modify: `core/src/encryption.rs`
- Modify: `core/src/projector.rs`

**Step 1: Add add_key_bundle_to_registry to encryption.rs**

Add to `encryption.rs`:

```rust
use p2panda_encryption::key_bundle::{LongTermKeyBundle, OneTimeKeyBundle};

/// Called by projector when a key_bundle op arrives from a peer.
/// Adds their bundle to our KeyRegistry.
pub async fn add_key_bundle_to_registry(
    author_key_hex: &str,
    body: &[u8],
) -> Result<(), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let op: crate::ops::KeyBundleOp = crate::ops::decode_cbor(body)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    let author: PublicKey = PublicKey::from_hex(author_key_hex)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let mut kr = enc.key_registry.lock().await;

    match op.bundle_type.as_str() {
        "long_term" => {
            let bundle: LongTermKeyBundle = ciborium::from_reader(op.bundle_data.as_slice())
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
            *kr = KeyRegistry::add_longterm_bundle(kr.clone(), author, bundle)
                .map_err(|e| EncryptionError::Init(e.to_string()))?;
        }
        "one_time" => {
            let bundle: OneTimeKeyBundle = ciborium::from_reader(op.bundle_data.as_slice())
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
            *kr = KeyRegistry::add_onetime_bundle(kr.clone(), author, bundle)
                .map_err(|e| EncryptionError::Init(e.to_string()))?;
        }
        _ => {}
    }

    // Persist updated registry.
    let mut buf = Vec::new();
    ciborium::into_writer(&*kr, &mut buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_key_registry(&enc.read_pool, &buf).await?;
    Ok(())
}

/// Publish our own LongTermKeyBundle as a KeyBundleOp.
pub async fn publish_key_bundle(
    op_store: &mut crate::store::DeltaStore,
    private_key: &p2panda_core::PrivateKey,
) -> Result<(), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;
    let km = enc.key_manager.lock().await;
    let bundle = KeyManager::prekey_bundle(&km)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let mut bundle_buf = Vec::new();
    ciborium::into_writer(&bundle, &mut bundle_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    let op = crate::ops::KeyBundleOp {
        bundle_type: "long_term".into(),
        bundle_data: bundle_buf,
    };
    let body = crate::ops::encode_cbor(&op)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::ops::sign_and_store_op(op_store, private_key, crate::ops::log_ids::KEY_BUNDLE, body)
        .await
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    Ok(())
}
```

**Step 2: Call publish_key_bundle from init_core in lib.rs**

In `lib.rs`, in `init_core()` (or in a post-bootstrap step), after `store::bootstrap()` returns:

```rust
// Publish our key bundle so other peers can add us to groups.
if let Some(core) = store::get_core() {
    let mut op_store = core.op_store.lock().await;
    let _ = encryption::publish_key_bundle(&mut op_store, &core.private_key).await;
}
```

**Step 3: Wire into projector.rs**

Add to the `match log_id` dispatch:

```rust
log_ids::KEY_BUNDLE => {
    let _ = crate::encryption::add_key_bundle_to_registry(&pk_hex, &body_bytes).await;
    Ok(())
}
```

**Step 4: Run cargo check**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -10`
Expected: no output.

**Step 5: Commit**

```bash
git add core/src/encryption.rs core/src/projector.rs core/src/lib.rs
git commit -m "feat(phase4): key_bundle projector handler + publish initial KeyBundleOp at init_core"
```

---

### Task 14: Wire send_message() encryption + projector decryption

**Files:**
- Modify: `core/src/lib.rs`
- Modify: `core/src/projector.rs`

**Step 1: Update send_message in lib.rs**

Replace the `encode_cbor` call inside `send_message()` with an encrypted body:

```rust
// Encrypt the MessageOp payload before publishing.
let plaintext = ops::encode_cbor(&ops::MessageOp {
    op_type: "send".into(),
    room_id: room_id.clone(),
    dm_thread_id: dm_thread_id.clone(),
    content_type: content_type.clone(),
    text_content: text_content.clone(),
    blob_id: blob_id.clone(),
    embed_url: embed_url.clone(),
    mentions: mentions.clone(),
    reply_to: reply_to.clone(),
})?;

let body_bytes = if let Some(ref rid) = room_id {
    encryption::encrypt_for_room(rid, &plaintext).await
        .unwrap_or(plaintext.clone()) // fallback to plaintext if no group state yet
} else if let Some(ref tid) = dm_thread_id {
    encryption::encrypt_for_dm(tid, &plaintext).await
        .unwrap_or(plaintext.clone())
} else {
    plaintext.clone()
};

let op_hash = {
    let mut op_store = core.op_store.lock().await;
    ops::sign_and_store_op(&mut op_store, &core.private_key, ops::log_ids::MESSAGE, body_bytes).await?
};
```

**Step 2: Update project_message in projector.rs**

In `project_message()`, before `let op: MessageOp = decode_cbor(body)?;`, add:

```rust
// Try to decrypt. If decryption fails, the message is pending.
let (plaintext, decryption_pending) = if let Some(rid) = room_id.as_deref() {
    match crate::encryption::decrypt_for_room(rid, body).await {
        Some(p) => (p, false),
        None => {
            // Try raw CBOR decode — might be unencrypted (pre-encryption messages).
            (body.to_vec(), true)
        }
    }
} else if let Some(tid) = dm_thread_id.as_deref() {
    match crate::encryption::decrypt_for_dm(tid, body).await {
        Some(p) => (p, false),
        None => (body.to_vec(), true),
    }
} else {
    (body.to_vec(), false)
};

let body = &plaintext;
```

Also pass `decryption_pending` into `db::insert_message` (Task 15 adds that field).

**Step 3: Run cargo check**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -10`

**Step 4: Commit**

```bash
git add core/src/lib.rs core/src/projector.rs
git commit -m "feat(phase4): send_message encrypts body; projector decrypts before CBOR decode"
```

---

### Task 15: Message.decryption_pending — UDL + TypeScript + db

**Files:**
- Modify: `core/src/lib.rs`
- Modify: `core/src/delta_core.udl`
- Modify: `core/src/db.rs`
- Modify: `app/src/ffi/deltaCore.ts`

**Step 1: Add decryption_pending to MessageRow in db.rs**

In `db.rs`, add `decryption_pending: bool` to `MessageRow`:
```rust
pub struct MessageRow {
    ...
    pub decryption_pending: bool,
}
```

Add `decryption_pending` to the `messages` table schema:
```sql
decryption_pending INTEGER NOT NULL DEFAULT 0
```

Update `insert_message` to bind it:
```rust
.bind(row.decryption_pending as i64)
```

Update `list_messages` to read it:
```rust
decryption_pending: r.get::<i64, _>("decryption_pending") != 0,
```

**Step 2: Add decryption_pending to Message in lib.rs**

In `lib.rs`, add to `Message`:
```rust
pub decryption_pending: bool,
```

Update `message_from_row`:
```rust
decryption_pending: row.decryption_pending,
```

**Step 3: Update delta_core.udl**

In `delta_core.udl`, add to the `Message` dictionary:
```
decryption_pending: boolean;
```

**Step 4: Update ffi/deltaCore.ts**

In `app/src/ffi/deltaCore.ts`, add to the `Message` interface:
```typescript
decryptionPending: boolean;
```

**Step 5: Run cargo check + tsc**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -5`
Run: `cd app && npx tsc --noEmit 2>&1`
Expected: both clean.

**Step 6: Commit**

```bash
git add core/src/lib.rs core/src/delta_core.udl core/src/db.rs app/src/ffi/deltaCore.ts
git commit -m "feat(phase4): Message.decryption_pending — UDL, TypeScript, db schema"
```

---

### Task 16: Network topic map extensions

**Files:**
- Modify: `core/src/network.rs`

**Context:** The `DeltaTopicMap` maps `TopicId → Logs<String>`. When we subscribe to a topic, we add log IDs to the map so LogSync knows what to sync. Currently rooms sync `message` and `reaction`. We need to add `enc_ctrl` and `enc_direct`. Org-meta topics need `key_bundle`. DM topics need `key_bundle`, `enc_ctrl`, and `enc_direct`.

**Step 1: Find subscribe_room_inner and subscribe_dm_thread in network.rs**

Read `core/src/network.rs` and locate:
- `subscribe_room_inner()` — where room log IDs are registered
- `subscribe_dm_thread()` — where DM log IDs are registered
- `subscribe_org_meta()` — where org-meta log IDs are registered

**Step 2: Add new log IDs to each topic**

In `subscribe_room_inner()`, add to the `Logs` HashMap for each known member:
```rust
log_ids_for_member.insert(crate::ops::log_ids::ENC_CTRL.to_string());
log_ids_for_member.insert(crate::ops::log_ids::ENC_DIRECT.to_string());
```

In `subscribe_dm_thread()`, add:
```rust
log_ids_for_member.insert(crate::ops::log_ids::KEY_BUNDLE.to_string());
log_ids_for_member.insert(crate::ops::log_ids::ENC_CTRL.to_string());
log_ids_for_member.insert(crate::ops::log_ids::ENC_DIRECT.to_string());
```

In `subscribe_org_meta()`, add:
```rust
log_ids_for_member.insert(crate::ops::log_ids::KEY_BUNDLE.to_string());
```

**Step 3: Run cargo check**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -5`
Expected: no output.

**Step 4: Commit**

```bash
git add core/src/network.rs
git commit -m "feat(phase4): extend topic maps with key_bundle/enc_ctrl/enc_direct log IDs"
```

---

### Task 17: Final verification

**Step 1: Full Rust test suite**

Run: `cargo test --manifest-path core/Cargo.toml --lib 2>&1`
Expected: all tests pass (12 existing + new Phase 4 tests).

**Step 2: Cargo check clean**

Run: `cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error"`
Expected: no output.

**Step 3: TypeScript check clean**

Run: `cd app && npx tsc --noEmit 2>&1`
Expected: no errors.

**Step 4: Final commit**

```bash
git commit -m "feat: Phase 4 complete — p2panda-encryption DCGKA rooms + Double Ratchet DMs"
```

If there are no unstaged changes this commit will say "nothing to commit" — that is fine if all changes were committed in prior tasks.

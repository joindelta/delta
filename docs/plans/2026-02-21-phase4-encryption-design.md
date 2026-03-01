# Delta — Phase 4 Encryption Design
**Date:** 2026-02-21
**Status:** Approved

---

## Overview

Phase 4 wires `p2panda-encryption` into `core`, giving Delta end-to-end encrypted rooms (data scheme — shared symmetric key with post-compromise security) and encrypted DM threads (message scheme — Double Ratchet with forward secrecy). Encryption is transparent to React Native — `send_message` encrypts, `list_messages` returns plaintext, no new UniFFI functions required.

---

## Architecture

A new `EncryptionCore` singleton is added to `core` alongside `NetworkCore`. Both are initialized inside `bootstrap()`.

```
core/src/
  encryption.rs   ← new: EncryptionCore singleton + all crypto logic
  store.rs        ← bootstrap() calls init_encryption()
  ops.rs          ← new log IDs + new op types + encrypt before store
  projector.rs    ← decrypt before CBOR decode
  db.rs           ← new tables: enc_group_state, enc_key_registry, enc_key_manager
```

### Type Aliases

```rust
type DeltaGroupState    = GroupState<PublicKey, Hash, KeyRegistry<PublicKey>,
                                     DeltaDgm, KeyManager, DeltaOrdering>;
type DeltaMsgGroupState = MsgGroupState<PublicKey, Hash, KeyRegistry<PublicKey>,
                                        DeltaDgm, KeyManager, DeltaOrdering>;
```

### EncryptionCore Struct

```rust
pub struct EncryptionCore {
    key_manager:  Mutex<KeyManagerState>,
    key_registry: Mutex<KeyRegistryState<PublicKey>>,
    room_groups:  Mutex<HashMap<String, DeltaGroupState>>,    // room_id → state
    dm_groups:    Mutex<HashMap<String, DeltaMsgGroupState>>, // thread_id → state
    read_pool:    SqlitePool,
}

static ENCRYPTION: OnceLock<EncryptionCore> = OnceLock::new();
```

### DeltaDgm

`DeltaDgm` is a Phase 4 stub implementing `GroupMembership<PublicKey, Hash>`. Initialized from the `memberships` table at `bootstrap()`, updated in-memory as DCGKA add/remove ops arrive. Phase 5 replaces this with `p2panda-auth`.

### DeltaOrdering

`DeltaOrdering` implements `Ordering<PublicKey, Hash, DeltaDgm>` using p2panda op `seq_num` + `backlink` — the causal chain is already built into the p2panda-core header.

---

## New Log Types & Op Payloads

Three new log IDs added to `ops::log_ids`:

```rust
pub const KEY_BUNDLE: &str = "key_bundle";  // our own pre-key material
pub const ENC_CTRL:   &str = "enc_ctrl";    // DCGKA ControlMessage (broadcast)
pub const ENC_DIRECT: &str = "enc_direct";  // DCGKA DirectMessage (per-recipient)
```

### Payload Structs

```rust
// Published by each peer to advertise their pre-key material.
// bundle_type: "long_term" (rooms, data scheme) | "one_time" (DMs, message scheme)
pub struct KeyBundleOp {
    pub bundle_type: String,
    pub bundle_data: Vec<u8>,  // CBOR-encoded LongTermKeyBundle or OneTimeKeyBundle
}

// DCGKA control message — broadcast to all current group members.
pub struct EncCtrlOp {
    pub group_id:  String,    // room_id or thread_id
    pub ctrl_data: Vec<u8>,   // CBOR-encoded ControlMessage
}

// DCGKA direct message — addressed to one specific recipient.
pub struct EncDirectOp {
    pub group_id:      String,  // room_id or thread_id
    pub recipient_key: String,  // hex public key of addressee
    pub direct_data:   Vec<u8>, // CBOR-encoded DirectMessage (encrypted toward recipient)
}
```

### Topic Map Additions

| Topic | Log IDs added |
|---|---|
| Org meta | `key_bundle` for all known org members |
| Room | `enc_ctrl`, `enc_direct` for known room members |
| DM thread | `key_bundle`, `enc_ctrl`, `enc_direct` for both parties |

---

## Encryption / Decryption Data Flow

### Write Path — Sending a Message

```
send_message(room_id, text_content, ...)
  → encode MessageOp to CBOR → plaintext_bytes
  → encryption::encrypt_for_room(room_id, plaintext_bytes)
      → look up DeltaGroupState for room_id
      → encrypt_data(secret_bundle.latest(), plaintext_bytes)
      → returns EncryptedBody { secret_id, nonce, ciphertext }
  → CBOR-encode EncryptedBody → body_bytes
  → sign_and_store_op(store, private_key, "message", body_bytes)
  → gossip fire-and-forget (unchanged)
```

DM messages follow the same shape using `MessageGroup::encrypt_message` and the Double Ratchet state.

### Write Path — DCGKA Group Operations

```
create_room(org_id, name)
  → publish RoomOp (plaintext, unchanged)
  → encryption::init_room_group(room_id, initial_members)
      → EncryptionGroup::create(state, members, rng)
      → returns GroupOutput { ctrl_message, direct_messages }
  → publish EncCtrlOp  → sign_and_store_op(..., "enc_ctrl", ...)
  → for each DirectMessage:
      publish EncDirectOp → sign_and_store_op(..., "enc_direct", ...)
  → persist updated GroupState to SQLite
```

### Read Path — Projector Decrypts Before Projecting

```
project_tick() receives body_bytes for log_id "message"
  → encryption::decrypt_body(room_id_or_thread_id, body_bytes)
      → CBOR-decode EncryptedBody { secret_id, nonce, ciphertext }
      → look up GroupSecret by secret_id in SecretBundle
      → decrypt_data(secret, nonce, ciphertext) → plaintext_bytes
      → on failure: return DecryptionPending (GroupState not ready yet)
  → decode_cbor::<MessageOp>(plaintext_bytes)
  → project_message(...)   ← unchanged from here

project_tick() receives body_bytes for log_id "enc_ctrl"
  → encryption::process_ctrl(group_id, author_key, body_bytes)
      → CBOR-decode EncCtrlOp
      → EncryptionGroup::process(state, ctrl_message)
      → updates GroupState (new secrets, member list)
      → persist updated GroupState to SQLite

project_tick() receives body_bytes for log_id "enc_direct"
  → skip if recipient_key ≠ my public key
  → encryption::process_direct(group_id, body_bytes)
      → CBOR-decode EncDirectOp
      → EncryptionGroup::process(state, direct_message)
      → persist updated GroupState to SQLite
```

---

## State Persistence

All encryption state is persisted in the read-model SQLite database (local-only, never synced to peers). Write-through on every mutation — no async flush.

### New Tables

```sql
-- Per-group DCGKA state (rooms: data scheme, DM threads: message scheme).
CREATE TABLE IF NOT EXISTS enc_group_state (
    group_id    TEXT PRIMARY KEY,
    group_type  TEXT NOT NULL,   -- "room" | "dm"
    state_data  BLOB NOT NULL    -- CBOR-encoded GroupState or MessageGroupState
);

-- Public key material collected from other peers.
CREATE TABLE IF NOT EXISTS enc_key_registry (
    public_key   TEXT NOT NULL,
    bundle_id    TEXT NOT NULL,
    bundle_type  TEXT NOT NULL,  -- "long_term" | "one_time"
    bundle_data  BLOB NOT NULL,
    PRIMARY KEY (public_key, bundle_id)
);

-- Our own KeyManagerState. Single row, one identity per device.
CREATE TABLE IF NOT EXISTS enc_key_manager (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    state_data  BLOB NOT NULL    -- CBOR-encoded KeyManagerState
);
```

### Bootstrap Sequence

```
bootstrap()
  → init_encryption(private_key_hex, read_pool)
      → load KeyManagerState from enc_key_manager
          → if missing: KeyManager::init_and_generate_prekey() + persist
          → check LongTermKeyBundle lifetime; if ≤ 3 days: rotate + publish KeyBundleOp
      → load KeyRegistryState from enc_key_registry
      → load all GroupState rows from enc_group_state
      → set ENCRYPTION singleton
```

---

## UniFFI Surface

Encryption is transparent. No new UniFFI functions. Internal call site changes only:

| Function | Phase 4 change |
|---|---|
| `init_core()` | calls `init_encryption()`, publishes initial `KeyBundleOp` |
| `create_room()` | calls `encryption::init_room_group()`, publishes `EncCtrlOp` + `EncDirectOp`s |
| `create_dm_thread()` | calls `encryption::init_dm_group()`, publishes `EncCtrlOp` + `EncDirectOp` |
| `send_message()` | encrypts body before `publish()` |
| `list_messages()` | reads already-decrypted plaintext (projector handles it) |

### Message Struct Addition

`Message` gains one flag for the race where a message arrives before the `enc_direct` bootstrapping it has been processed:

```
Message {
  ...existing fields...
  decryption_pending: bool   // true if GroupState not yet ready
}
```

React Native shows a `"•••"` placeholder. The 500ms projector poll retries automatically once `enc_direct` is processed.

---

## Files Changed / Added

### Rust
- `core/src/encryption.rs` — new: EncryptionCore singleton, DeltaDgm, DeltaOrdering, all encrypt/decrypt helpers
- `core/src/store.rs` — `bootstrap()` calls `init_encryption()`
- `core/src/ops.rs` — new log IDs (`key_bundle`, `enc_ctrl`, `enc_direct`), new op structs, `sign_and_store_op` encrypts message/reaction bodies
- `core/src/projector.rs` — decrypt before CBOR decode for `message`, process `enc_ctrl`/`enc_direct`/`key_bundle` ops
- `core/src/db.rs` — three new tables + helpers
- `core/src/lib.rs` — `Message` struct gains `decryption_pending`
- `core/src/network.rs` — topic maps extended with new log IDs
- `core/src/delta_core.udl` — `Message` dict updated

### React Native
- `app/src/ffi/deltaCore.ts` — `Message` type gains `decryptionPending: boolean`
- `app/src/stores/useMessagesStore.ts` — render `"•••"` when `decryptionPending`

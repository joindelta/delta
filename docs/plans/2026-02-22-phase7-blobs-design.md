# Phase 7 — Blobs, Pre-key Bundles & Full DCGKA Room Encryption
**Date:** 2026-02-22
**Status:** Approved

---

## Context

Phase 7 completes blob storage and wires it to the full DCGKA room encryption pipeline
from Phase 4. Rather than using the simpler `SecretBundle` shortcut, we wire the
complete `GroupState` machinery (already implemented in `encryption.rs`) end-to-end.
Pre-key bundle publishing (required for multi-member `GroupState::add`) is included so
we never have to revisit this.

### What is already in place

- `blobs.rs` — `upload_blob(data)` / `get_blob(hash)` compile; use filesystem +
  `p2panda_core::Hash`; registered in UDL and re-exported from `lib.rs`
- `enc_group_state` table — `save/load_enc_group_state` helpers exist in `db.rs`
- `enc_key_manager` / `enc_key_registry` tables and helpers exist
- `KEY_BUNDLE`, `ENC_CTRL`, `ENC_DIRECT` log IDs defined in `ops.rs`
- `GardensGroupState` / `GardensMsgGroupState` type aliases defined
- All DGM types (`GardensDgm`, `GardensOrdering`, etc.) implemented and tested
- `EncryptionCore` singleton initialised in `init_encryption()`
- `key_bundles` table exists in schema
- `MessageBubble` has placeholder renderers for image / audio / gif / video
- `MessageComposer` has a "+" attach stub button
- `gardensCore.ts` bridge exists with all prior phases wired

### What is missing

- `upload_blob` lacks `mime_type` and `room_id` params
- `encrypt_for_room` / `decrypt_for_room` are stubs
- `init_room_group` is a stub
- No pre-key bundle in `ProfileOp` or projector
- No `blob_meta` table
- TS bridge missing `uploadBlob` / `getBlob`
- React Native has no `BlobImage` component, no real picker/PTT/GIF wiring

---

## Architecture

```
ProfileOp { pre_key_bundle }
      │
      ▼
projector::project_profile
      │  KeyRegistry::add_longterm_bundle
      ▼
enc_key_registry (SQLite)
      │
      ▼
init_room_group(room_id, members)
      │  GroupState::init + GroupState::create
      ▼
enc_group_state (SQLite, keyed by room_id)
      │
      ├──► encrypt_for_room → GroupState::send → EncryptedBody
      │                                              │
      └──► decrypt_for_room ◄─────────────────────────
               │  GroupState::receive → GroupOutput::Application
               ▼
          plaintext blob bytes

upload_blob(data, mime_type, room_id?)
      │  encrypt_for_room if room_id present
      ▼
blob file on disk  +  blob_meta row (hash, mime, room_id, sender_key, secret_id, nonce)

get_blob(hash)
      │  look up blob_meta → decrypt_for_room if encrypted
      ▼
plaintext bytes → React Native
```

---

## Part A — Pre-key Bundle Publishing

### `ops.rs`
Add optional field to `ProfileOp`:
```rust
pub struct ProfileOp {
    pub op_type: String,
    pub username: String,
    pub avatar_blob_id: Option<String>,
    pub bio: Option<String>,
    pub available_for: Vec<String>,
    pub pre_key_bundle: Option<Vec<u8>>,  // CBOR-encoded LongTermKeyBundle
}
```

### `lib.rs` — `create_or_update_profile()`
After locking `op_store`, call:
```rust
let bundle_bytes: Option<Vec<u8>> = get_encryption().and_then(|enc| {
    let km = enc.key_manager.try_lock().ok()?;
    let bundle = KeyManager::prekey_bundle(&km).ok()?;
    let mut buf = Vec::new();
    ciborium::into_writer(&bundle, &mut buf).ok()?;
    Some(buf)
});
```
Include `pre_key_bundle: bundle_bytes` in the `ProfileOp`.

### `projector.rs` — `project_profile()`
After upserting the profile row, if `op.pre_key_bundle` is `Some`:
1. Deserialize: `ciborium::from_reader::<LongTermKeyBundle, _>(bytes)`
2. Convert `author_key` hex → `PublicKey` → `Id`
3. Load `enc_key_registry`, call `KeyRegistry::add_longterm_bundle(state, author_id, bundle)`
4. Persist updated registry via `db::save_enc_key_registry`

---

## Part B — `init_room_group` Wiring

Signature (unchanged):
```rust
pub async fn init_room_group(
    room_id: &str,
    initial_members: Vec<PublicKey>,
) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), EncryptionError>
```

Implementation steps:
1. Get `EncryptionCore`; clone `km_state` and `kr_state` from their Mutexes
2. Build `my_id = Id(enc.my_public_key)`
3. Build `all_ids: Vec<Id>` from `initial_members`
4. `GardensDgm::create(my_id, &all_ids)` → `dgm_state`
5. `GardensOrdering::init(enc.my_public_key)` → `ord_state`
6. `GroupState::init(my_id, km_state, kr_state, dgm_state, ord_state)` → `y`
7. `GroupState::create(y, all_ids, &rng)` → `(new_state, ctrl_msg: GardensMessage)`
8. CBOR-serialize `new_state`; `db::save_enc_group_state(pool, room_id, "room", &bytes)`
9. Persist updated `km_state` and `kr_state` from `new_state.dcgka`
10. CBOR-serialize `ctrl_msg` → `ctrl_bytes`
11. Per-recipient direct messages are embedded in `ctrl_msg.direct_messages()`; serialize
    each → `Vec<(recipient_hex, direct_bytes)>`
12. Return `(ctrl_bytes, directs)`

---

## Part C — `encrypt_for_room` / `decrypt_for_room`

### `EncryptedBody` (already defined)
```rust
pub struct EncryptedBody {
    pub secret_id: GroupSecretId,  // [u8; 32]
    pub nonce:     [u8; 24],
    pub ciphertext: Vec<u8>,
    pub sender_key: [u8; 32],      // ADD: needed to reconstruct GardensMessage on decrypt
}
```

### `encrypt_for_room(room_id, plaintext)`
1. Load CBOR group state from `enc_group_state` → deserialize as `GardensGroupState`
2. `GroupState::send(state, plaintext, &rng)` → `(new_state, msg: GardensMessage)`
3. Match `msg.content` as `Application { group_secret_id, nonce, ciphertext }`
4. Save `new_state` CBOR back to DB
5. Return `EncryptedBody { secret_id: group_secret_id, nonce: nonce.into(), ciphertext, sender_key: enc.my_public_key.into() }`

### `decrypt_for_room(room_id, body)`
1. Load CBOR group state → `GardensGroupState`
2. Reconstruct:
   ```rust
   let msg = GardensMessage {
       id: OpId(Hash::new(&body.ciphertext)),
       sender: Id(PublicKey::from_bytes(&body.sender_key)?),
       content: GardensMessageContent::Application {
           group_secret_id: body.secret_id,
           nonce: XAeadNonce::from(body.nonce),
           ciphertext: body.ciphertext,
       },
   };
   ```
3. `GroupState::receive(state, &msg)` → `(new_state, outputs)`
4. Save `new_state`
5. Find and return `GroupOutput::Application { plaintext }`

---

## Part D — `blob_meta` Table + `blobs.rs` Updates

### New table (added to `db.rs` `run_migrations`)
```sql
CREATE TABLE IF NOT EXISTS blob_meta (
    blob_hash   TEXT PRIMARY KEY,
    mime_type   TEXT NOT NULL,
    room_id     TEXT,         -- NULL = unencrypted
    sender_key  TEXT,         -- hex; needed for decrypt
    secret_id   BLOB,         -- [u8; 32] GroupSecretId
    nonce       BLOB          -- [u8; 24] XAeadNonce
);
```

### `blobs.rs` updated signatures
```rust
pub async fn upload_blob(
    bytes: Vec<u8>,
    mime_type: String,
    room_id: Option<String>,
) -> Result<String, BlobError>
```

Logic:
- Compute `hash = Hash::new(&bytes)` → `hash_str`
- If `room_id` is `Some(rid)`: call `encrypt_for_room(&rid, &bytes)` → `EncryptedBody`; write
  ciphertext to disk; insert blob_meta with room_id, sender_key, secret_id, nonce
- If `None`: write raw bytes to disk; insert blob_meta with nulls

```rust
pub async fn get_blob(hash_str: String) -> Result<Vec<u8>, BlobError>
```

Logic:
- Look up `blob_meta` row for `hash_str`
- If `room_id` is non-null: read ciphertext from disk; reconstruct `EncryptedBody` from
  meta row; call `decrypt_for_room(&room_id, body)` → plaintext
- Else: read raw bytes from disk

---

## Part E — UDL Update

```
// ── Phase 7: Blobs ─────────────────────────────────────────────────────
[Async, Throws=BlobError]
string upload_blob(bytes data, string mime_type, string? room_id);

[Async, Throws=BlobError]
bytes get_blob(string blob_hash);
```

---

## Part F — TypeScript Bridge (`gardensCore.ts`)

Add to `GardensCoreNative` interface:
```ts
uploadBlob(data: Uint8Array, mimeType: string, roomId: string | null): Promise<string>;
getBlob(blobHash: string): Promise<Uint8Array>;
```

Add stub fallbacks and exported wrappers:
```ts
export async function uploadBlob(
  data: Uint8Array,
  mimeType: string,
  roomId: string | null,
): Promise<string>

export async function getBlob(blobHash: string): Promise<Uint8Array>
```

---

## Part G — React Native Components

### `BlobImage.tsx` (new)
```
Props: blobHash: string, style?: ImageStyle, fallback?: ReactNode
```
- On mount: `getBlob(blobHash)` → convert bytes to base64 → `data:<mime>;base64,<b64>` URI
- Render `<Image source={{ uri }}>` with loading/error states
- Cache resolved URI in component state (no re-fetch on re-render)

### `MessageBubble.tsx` updates
- `contentType === 'image'` → `<BlobImage blobHash={message.blobId!} />`
- `contentType === 'video'` → `<BlobImage blobHash={message.blobId!} />` (poster frame; full playback deferred)
- `contentType === 'audio'` → `<AudioMessage blobHash={message.blobId!} />` inline component using `expo-av`
- `contentType === 'gif'` → `<Image source={{ uri: message.embedUrl! }} />`

### `MessageComposer.tsx` updates
New props:
```ts
roomId: string | null;
onSendBlob: (blobId: string, mimeType: string, contentType: 'image' | 'video') => void;
onSendAudio: (blobId: string) => void;
onSendGif: (embedUrl: string) => void;
```

"+" button opens `ActionSheet` with three options:
1. **Photo / Video** → `launchImageLibrary({ mediaType: 'mixed' })` → read bytes →
   `uploadBlob(bytes, mime, roomId)` → `onSendBlob`
2. **Voice message** → dedicated hold-to-record `<PTTButton>` (shown when text field empty)
   using `expo-av` `Audio.Recording` → stop → read URI → `uploadBlob` → `onSendAudio`
3. **GIF** → open `<GifSearchModal>` → `onSendGif`

### `GifSearchModal.tsx` (new)
- `TextInput` for Tenor query
- Tenor API key in `app/src/utils/config.ts` (placeholder constant)
- `FlatList` of results; tap → `onSelect(gifUrl)` → close modal

---

## Decisions & Trade-offs

| Decision | Rationale |
|---|---|
| Full DCGKA `GroupState` (not `SecretBundle` shortcut) | Already implemented; gives real forward secrecy and key rotation on member removal |
| Pre-key bundle in `ProfileOp` (not separate log) | Simplest delivery mechanism; `KEY_BUNDLE` log available for future rotation ops |
| `sender_key` stored in `blob_meta` | Needed to reconstruct `GardensMessage::Application` for `GroupState::receive` |
| `react-native-image-picker` + `expo-av` | Minimal surface area; works in bare RN; widely adopted |
| Tenor for GIF search | Free tier sufficient for launch; API key is a placeholder |
| `data:` URI for `BlobImage` | No temp file management; works on both iOS and Android |

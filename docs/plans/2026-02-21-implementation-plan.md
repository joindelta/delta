# Delta — Implementation Plan
**Date:** 2026-02-21
**Status:** Draft

---

## Phase 0 — Repo & Toolchain (Day 1)

- [ ] `cargo new core --lib` (Rust workspace)
- [ ] `npx react-native init DeltaApp --template react-native-template-typescript`
- [ ] Add `uniffi` to core; wire up `build.rs` for UniFFI scaffolding
- [ ] Configure iOS + Android CI targets (GitHub Actions)
- [ ] Add p2panda crates to `Cargo.toml`:
  ```
  p2panda-core, p2panda-store, p2panda-net,
  p2panda-auth, p2panda-encryption, p2panda-blobs
  ```

---

## Phase 1 — Identity & Biometric Auth

### Rust (core)
- [ ] `KeyManager`: generate/import Ed25519 keypair, BIP-39 mnemonic (24-word)
- [ ] Expose via UniFFI: `generate_keypair() -> KeyPair`, `import_from_mnemonic(words: Vec<String>) -> KeyPair`

### React Native
- [ ] `react-native-keychain` for iOS Keychain / Android Keystore
- [ ] Welcome Screen: "Create Account" | "Import (24-word seed)"
- [ ] Signup Screen: biometric enroll → username → avatar → bio → available_for
- [ ] Seed Recovery Screen: 24-word input → derive keypair → re-enroll biometric
- [ ] Auth context/store; gate Main navigator behind biometric unlock

---

## Phase 2 — Core Data Layer

### Rust (core)
- [ ] Init `p2panda-store` (SqliteStore) — operation log (write model)
- [ ] Init our SQLite read model (`rusqlite`) with schema from design doc
- [ ] `Projector` async task: subscribe to new ops from SqliteStore → decrypt → upsert read model
- [ ] Op builders: `ProfileOp`, `OrgOp`, `RoomOp`, `MessageOp`, `ReactionOp`, `DmThreadOp`
- [ ] UniFFI expose: profile CRUD, org CRUD, room CRUD, message send/edit/delete

### React Native
- [ ] Zustand stores: `useProfileStore`, `useOrgsStore`, `useDMStore`, `useMessagesStore`
- [ ] SQLite read model queries via UniFFI (profiles, orgs, rooms, messages, reactions, dm_threads)

---

## Phase 3 — Networking

### Rust (core)
- [ ] Init `p2panda-net` node (QUIC/TLS, Gossip, LogSync, mDNS)
- [ ] Bootstrap node config (hardcoded for launch; community-run)
- [ ] Gossip: broadcast new ops to online org members
- [ ] LogSync: request missed ops on reconnect
- [ ] DHT public org indexing: publish `org_id` on `is_public=true`; discover via search

### React Native
- [ ] Connection status indicator
- [ ] Discover Orgs Screen: DHT search results

---

## Phase 4 — Encryption

### Rust (core)
- [ ] Room encryption: `p2panda-encryption` **data scheme** (shared symmetric key, key rotation on member removal via `enc_key_epoch`)
- [ ] DM encryption: `p2panda-encryption` **message scheme** (X3DH + Double Ratchet)
- [ ] Pre-key bundle management: generate bundles, publish in `ProfileOp`, consume on DM init
- [ ] Projector: decrypt before writing to read model (data scheme for rooms, ratchet for DMs)

---

## Phase 5 — Membership

### Rust (core)
- [ ] `p2panda-auth` integration: AddMember, RemoveMember, ChangePerm DAG ops
- [ ] Projector: project auth DAG → `memberships` table
- [ ] Invite token: sign `{org_id, inviter_key, access_level, expiry}` with Ed25519 → base64 payload
- [ ] Token verify: check sig + expiry before dispatching join request
- [ ] UniFFI expose: add_member (NFC path), generate_invite_token, verify_and_join

### React Native
- [ ] NFC: `react-native-nfc-manager` — inviter holds NFC mode; invitee taps → pubkey exchange → confirm dialog
- [ ] QR invite: `react-native-qrcode-svg` to display; `react-native-camera` or `expo-barcode-scanner` to scan
- [ ] Add Member Sheet (NFC tab | QR tab)

---

## Phase 6 — Messaging UI

### Shared Components
- [ ] `<MessageBubble>` — text, blob, embed, audio, deleted state
- [ ] `<AudioMessage>` — Opus blob, waveform, play/pause
- [ ] `<ReactionBar>` — emoji + count + toggle
- [ ] `<MemberChip>` — avatar + username + access_level badge
- [ ] `<MessageComposer>` — text input, @mention autocomplete, emoji, GIF, attach, PTT
- [ ] `<RichEmbed>` — OGP preview on paste (unfurl in Rust)
- [ ] `<MentionToken>` — tappable → User Profile modal
- [ ] `<PublicKeyDisplay>` — truncated hex + copy + show QR

### Screens
- [ ] Room Chat Screen: `FlatList` messages, Composer, @mention autocomplete from `memberships`
- [ ] DM Chat Screen: same Composer, no @mentions, ratchet encryption indicator
- [ ] Org Screen: header + room tab bar (starts "general") + Room Chat
- [ ] Org Profile Screen: members list, admin panel for Manage-level

---

## Phase 7 — Blobs (Media & Audio)

### Rust (core)
- [ ] `p2panda-blobs`: store blob → get `BlobHash`, retrieve blob by hash
- [ ] Encrypt blob with room data scheme key before storing
- [ ] UniFFI expose: `upload_blob(bytes, mime_type) -> BlobHash`, `get_blob(hash) -> Bytes`

### React Native
- [ ] Image/video picker → upload blob → `MessageOp { content_type: "image"|"video", blob_id }`
- [ ] PTT: record Opus audio → upload blob → `MessageOp { content_type: "audio", blob_id }`
- [ ] `<BlobImage>` lazy-load via blob hash
- [ ] GIF: Tenor search → store embed_url in `MessageOp { content_type: "gif", embed_url }`

---

## Phase 8 — Home Feed & Profile

### Screens
- [ ] Home Tab: query recent messages across all orgs + DMs; group by source; tap → deep link
- [ ] My Profile Screen: avatar, username, bio, available_for chips, pubkey display, orgs
- [ ] Edit Profile Screen: dispatch `ProfileOp { op_type: "update_profile", ... }`
- [ ] User Profile Modal (global): avatar, username, bio, available_for, pubkey, mutual orgs, [Send DM] [Add to org]

---

## Phase 9 — Polish & Launch Prep

- [ ] Resolve open questions (push notifications strategy, Tenor vs Giphy, bootstrap node ops)
- [ ] Offline UX: queue ops locally → dispatch on reconnect
- [ ] Error boundaries; loading + empty states for all screens
- [ ] Accessibility (VoiceOver / TalkBack)
- [ ] App icons, splash screen, onboarding copy
- [ ] TestFlight (iOS) + Play Internal Testing (Android) builds
- [ ] App Store / Play Store submissionsLet

---

## File Structure

```
delta/
├── core/              # Rust crate
│   ├── src/
│   │   ├── lib.rs
│   │   ├── keys.rs          # KeyManager, BIP-39
│   │   ├── ops.rs           # Op builders (Profile, Org, Room, Message, Reaction, DmThread)
│   │   ├── store.rs         # p2panda-store init
│   │   ├── projector.rs     # async projection: ops → read model
│   │   ├── db.rs            # SQLite read model schema + queries
│   │   ├── network.rs       # p2panda-net init, Gossip, LogSync, DHT
│   │   ├── encryption.rs    # data scheme + message scheme wrappers
│   │   ├── auth.rs          # p2panda-auth wrappers, invite tokens
│   │   ├── blobs.rs         # p2panda-blobs wrappers
│   │   └── ffi.rs           # UniFFI bindings (udl + generated)
│   ├── delta_core.udl
│   └── Cargo.toml
│
└── DeltaApp/                # React Native
    └── src/
        ├── navigation/      # Auth stack + Main tab navigator
        ├── screens/         # One file per screen
        ├── components/      # Shared components (MessageBubble, Composer, etc.)
        ├── stores/          # Zustand stores
        ├── ffi/             # UniFFI generated JS bindings
        └── utils/
```

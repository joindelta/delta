# Delta — Design Document
**Date:** 2026-02-21
**Status:** Approved

---

## Overview

Delta is an encrypted, peer-to-peer Discord alternative for mobile (iOS + Android). It enables decentralized group communication through organizations ("Packs", "Collectives", "Communes", etc.), group-encrypted rooms, and 1:1 direct messages — all without any central server storing messages or managing identity.

---

## Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Platform | iOS + Android (mobile) | Biometric login, NFC, offline-first P2P |
| UI Framework | React Native + UniFFI | Mature ecosystem, best component support for chat UI |
| Architecture | Event-sourced / CQRS | P2Panda ops as write log, SQLite as derived read model |
| Network | Pure P2P + optional bootstrap nodes | No central message store; QUIC/TLS via p2panda-net |
| Voice | Push-to-talk audio messages | Maps cleanly to p2panda-blobs; no real-time complexity |
| Org types | Single flexible type with flavor names | Simpler data model; org type is aesthetic, not behavioral |
| Org discovery | Optional public orgs (DHT-indexed) | Private by default; creators opt into discoverability |

---

## Tech Stack

```
React Native (TypeScript)         ← UI layer
      ↓ UniFFI bindings
core (Rust)                 ← business logic
  ├── p2panda-core                (Ed25519 keys, BLAKE3 hashes, Operations, append-only logs)
  ├── p2panda-store (SqliteStore) (operation log persistence — the write side of CQRS)
  ├── p2panda-net                 (QUIC/TLS, Gossip, LogSync, mDNS, confidential peer discovery)
  ├── p2panda-auth                (DAG-based group membership, per-member access levels)
  ├── p2panda-encryption          (data scheme for rooms, message scheme for DMs)
  ├── p2panda-blobs               (content-addressed blob storage: avatars, audio, images)
  └── Our SQLite read model       (materialized view: messages, profiles, members, search)
```

### Crates Excluded (included transitively via p2panda-net)
- `p2panda-sync` — consumed internally by p2panda-net
- `p2panda-discovery` — consumed internally by p2panda-net

---

## Architecture: Event-Sourced / CQRS

```
                    [WRITE PATH]
User Action → Rust Core → sign Operation (p2panda-core)
                               ↓
                    p2panda-store (SqliteStore)  ← canonical operation log
                               ↓
                    Projector (Rust async task)
                               ↓ decrypt + materialize
                    [READ PATH]
                    Our SQLite Read Model
                               ↑ queries
                    React Native UI (via UniFFI)

                    [SYNC PATH]
    p2panda-net Gossip   ← real-time delivery (online peers)
    p2panda-net LogSync  ← catch-up delivery (offline peers, missed messages)
```

**Key properties:**
- All mutations flow through signed P2Panda operations — tamper-proof, causally ordered
- SQLite read model can be fully rebuilt by replaying the operation log
- Gossip handles real-time delivery; LogSync handles offline resilience
- Projector decrypts messages using appropriate key material before writing to read model

---

## Data Model

### Write Path — P2Panda Operation Payloads (CBOR-encoded)

These are the `Body` bytes of each `p2panda-core` Operation:

```
ProfileOp {
  op_type:        "create_profile" | "update_profile"
  username:       String
  avatar_blob_id: BlobHash?
  bio:            String?
  available_for:  Vec<String>        // ["collab", "hire", "mentoring", "open_source", ...]
  key_bundles:    Vec<KeyBundle>     // p2panda-encryption pre-keys for async DM key exchange
}

OrgOp {
  op_type:        "create_org" | "update_org"
  name:           String
  type_label:     String             // "Pack" | "Collective" | "Commune" | "Squad"
                                     // | "Nursery" | any user-defined string
  description:    String?
  avatar_blob_id: BlobHash?
  is_public:      bool               // if true, indexed in DHT for discovery
}

// Membership ops: owned by p2panda-auth (DAG operations, not custom op types)
// p2panda-auth handles: AddMember, RemoveMember, ChangePerm
// Access levels: Pull → Read → Write → Manage (hierarchical supersets)
// Conflict resolution: strong removal (default) — concurrent removes/demotes
//   by managers invalidate each other's concurrent ops transitively

RoomOp {
  op_type:        "create_room" | "update_room"
  org_id:         OperationHash
  name:           String             // default first room: "general"
  enc_key_epoch:  u64               // increments on each member removal → key rotation
}

MessageOp {
  op_type:        "send" | "edit" | "delete"
  room_id:        OperationHash?    // null for DMs
  dm_thread_id:   OperationHash?   // null for room messages
  content_type:   "text" | "audio" | "image" | "gif" | "video" | "embed"
  encrypted_body: Bytes             // p2panda-encryption (scheme depends on context)
  mentions:       Vec<PublicKey>
  reply_to:       OperationHash?
}

ReactionOp {
  op_type:        "add_reaction" | "remove_reaction"
  message_id:     OperationHash
  emoji:          String
}

DmThreadOp {
  op_type:        "create_thread"
  recipient_key:  PublicKey
  x3dh_handshake: Bytes             // p2panda-encryption X3DH key agreement payload
}
```

---

### Read Path — SQLite Materialized View

Projected from `p2panda-store` by the Projector. Messages decrypted at projection time.

```sql
-- Identities / Profiles
CREATE TABLE profiles (
  public_key      TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  avatar_blob_id  TEXT,
  bio             TEXT,
  available_for   TEXT,             -- JSON: ["collab", "hire", ...]
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- p2panda-encryption pre-keys for asynchronous DM key exchange
CREATE TABLE key_bundles (
  public_key      TEXT NOT NULL,
  bundle_id       TEXT NOT NULL,
  bundle_data     BLOB NOT NULL,
  PRIMARY KEY (public_key, bundle_id)
);

-- Organizations
CREATE TABLE organizations (
  org_id          TEXT PRIMARY KEY, -- root operation hash (stable ID)
  name            TEXT NOT NULL,
  type_label      TEXT NOT NULL,
  description     TEXT,
  avatar_blob_id  TEXT,
  is_public       INTEGER NOT NULL, -- 0=private, 1=public (DHT-indexed)
  creator_key     TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

-- Memberships (projected from p2panda-auth DAG operations)
CREATE TABLE memberships (
  org_id          TEXT NOT NULL,
  member_key      TEXT NOT NULL,
  access_level    TEXT NOT NULL,    -- "pull" | "read" | "write" | "manage"
  joined_at       INTEGER,
  added_via       TEXT,             -- "nfc" | "qr" | "invite_link"
  added_by        TEXT,
  PRIMARY KEY (org_id, member_key)
);

-- Rooms (channels within an org)
CREATE TABLE rooms (
  room_id         TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  enc_key_epoch   INTEGER NOT NULL DEFAULT 0
);

-- Messages (stored decrypted in read model)
CREATE TABLE messages (
  message_id      TEXT PRIMARY KEY, -- P2Panda operation hash
  room_id         TEXT,
  dm_thread_id    TEXT,
  author_key      TEXT NOT NULL,
  content_type    TEXT NOT NULL,    -- "text" | "audio" | "image" | "gif" | "video" | "embed"
  text_content    TEXT,
  blob_id         TEXT,             -- p2panda-blobs content hash (audio, image, video)
  embed_url       TEXT,             -- for link previews / GIFs
  mentions        TEXT,             -- JSON: ["<pubkey>", ...]
  reply_to        TEXT,             -- message_id of parent
  timestamp       INTEGER NOT NULL,
  edited_at       INTEGER,
  is_deleted      INTEGER NOT NULL DEFAULT 0
);

-- Reactions (CRDT map projected from ReactionOps)
CREATE TABLE reactions (
  message_id      TEXT NOT NULL,
  emoji           TEXT NOT NULL,
  reactor_key     TEXT NOT NULL,
  PRIMARY KEY (message_id, emoji, reactor_key)
);

-- Direct Message Threads
CREATE TABLE dm_threads (
  thread_id         TEXT PRIMARY KEY,
  initiator_key     TEXT NOT NULL,
  recipient_key     TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_message_at   INTEGER
);
```

---

### Encryption Strategy

| Context | Scheme | Properties |
|---|---|---|
| Group room messages | `p2panda-encryption` **data scheme** | Shared symmetric key; late joiners access history; key rotation on member removal (post-compromise security) |
| DM messages | `p2panda-encryption` **message scheme** | Double Ratchet (Signal-like); per-message keys; forward secrecy; X3DH bootstrap via key bundles |
| Blobs (avatars, audio, images) | `p2panda-blobs` + data scheme key | Content-addressed; encrypted at rest; streamed on demand |
| Profile data | Unencrypted | Public by design — profiles are identity cards |
| Org metadata | Unencrypted | Required for discovery (public orgs) and sync routing |

---

## Identity & Biometric Auth

```
First Launch — Create Account:
  1. Generate Ed25519 keypair (p2panda-core PrivateKey)
  2. Store private key → iOS Keychain / Android Keystore (hardware-backed TEE)
  3. Enroll biometric (FaceID / TouchID / Fingerprint)
  4. Display 24-word BIP-39 mnemonic ("Write this down — shown once")
  5. Signup screen: username → avatar → bio → available_for → dispatch ProfileOp

Subsequent Launches:
  1. Biometric prompt → unlock private key from Keystore
  2. Key available for all p2panda-core operation signing

Import / Recovery:
  1. Enter 24-word mnemonic → derive Ed25519 keypair
  2. Re-enroll biometric
  3. Fetch ops from network by public key → Projector rebuilds read model
```

The `public_key` is the canonical identity. Usernames are display-only and mutable.

---

## Membership: NFC + QR Flows

### NFC (in-person)
```
Inviter opens "Add Member" → NFC mode
  → displays "Hold phones together"
  → Invitee: NFC tap triggers public key exchange
  → Inviter: sees "Add [username] as [access_level]?" confirm dialog
  → Confirm → dispatches p2panda-auth AddMember op
```

### QR Code (remote)
```
Inviter generates time-limited signed invite token (org_id + inviter_key + expiry + sig)
  → shown as QR code
  → Invitee scans → app verifies sig + expiry
  → Auto-joins if valid → dispatches join request op
  → Inviter's client (or any Manage-level member) countersigns to finalize
```

---

## Network Architecture

```
Peer A ←── QUIC/TLS (iroh) ───→ Peer B
              ↑
     Bootstrap node(s)
   (discovery only — no message store)

Local network: mDNS (p2panda-net built-in)
Internet:      QUIC + bootstrap node peer discovery
```

- **Gossip**: real-time broadcast to online org members
- **LogSync**: eventual consistency — peers sync missed operations when reconnecting
- **Bootstrap nodes**: community-run; store peer addresses only, never message content
- **Public org discovery**: DHT-indexed by `org_id` hash; private orgs never appear

---

## UI Architecture

### Navigation

```
App
├── Auth Stack
│   ├── Welcome Screen
│   ├── Signup Screen
│   └── Seed Recovery Screen
│
└── Main Tab Navigator
    ├── 🏠 Home     (activity feed)
    ├── 🌐 Orgs     (organizations)
    ├── 💬 DMs      (direct messages)
    └── 👤 Profile  (your identity)
```

### Screen Map

**Auth Stack**
- **Welcome**: "Create Account" | "Import Account (24-word seed)"
- **Signup**: username → avatar upload → bio → available_for tag picker
- **Seed Recovery**: 24-word input → derive keypair → biometric re-enrollment

**Home Tab**
- Activity feed: recent messages across all orgs + DMs, grouped by source, sorted by timestamp. Tap row → deep link to room or DM.

**Orgs Tab**
- **Org List**: Card per org (avatar, name, `TypeLabelBadge`, member count). FAB: Create Org | Discover Public Orgs.
- **Org Screen**: Header (avatar, name, badge, member count, ⚙️). Room tabs (starts with "general"). Room view: message list + Composer.
- **Org Profile Screen**: avatar, name, badge, description, member list (`MemberChip` rows with access_level), join/invite actions, Admin Panel (Manage-level only: edit org, add room, remove members).
- **Create Org Screen**: name → type_label picker → description → avatar → public/private toggle.
- **Discover Orgs Screen**: search field + list of DHT-indexed public orgs.

**DMs Tab**
- **DM List**: rows sorted by `last_message_at`. Avatar + username + last message preview. FAB: New DM.
- **DM Chat Screen**: header (avatar, username, truncated pubkey). Message list. Composer (no @mentions).
- **New DM Screen**: scan public key QR | paste/type public key.

**Profile Tab**
- **My Profile**: avatar (tap to edit), username, bio, available_for chips, public key (`PublicKeyDisplay`), orgs (public). Edit button.
- **Edit Profile**: edits all fields → dispatches `ProfileOp`.

### Global Modals

- **User Profile View** (tap any member): avatar, username, bio, available_for, public key, mutual orgs, [Send DM] [Add to org ▾]
- **Add Member Sheet**: NFC tab (waiting UI → confirm) | QR tab (show invite QR or scan public key QR)

### Message Composer

```
[Text input — @mention autocomplete from memberships]
[😀 Emoji] [GIF search → Tenor] [📎 Attach → p2panda-blobs] [🎤 Push-to-talk]
Auto link preview → RichEmbed card on paste
```

Composer is the same component in rooms and DMs, configured by context (`room_id` vs `dm_thread_id`, encryption scheme, @mention source).

### UI Components (named to match data model)

| Component | Entity |
|---|---|
| `<MessageBubble>` | `messages` row — renders text, blob, embed, or audio |
| `<AudioMessage>` | blob (audio/opus) — waveform visualization + play/pause |
| `<ReactionBar>` | `reactions` CRDT map — emoji + count + "did I react?" |
| `<MemberChip>` | `memberships` — avatar + username + access_level badge |
| `<OrgCard>` | `organizations` row |
| `<TypeLabelBadge>` | `type_label` — pill badge ("Pack", "Collective", etc.) |
| `<PublicKeyDisplay>` | `public_key` — truncated hex + [Copy] + [Show QR] |
| `<BlobImage>` | `blob_id` — content-addressed, streamed via p2panda-blobs |
| `<RichEmbed>` | `embed_url` — OGP preview card |
| `<MentionToken>` | mention in message text — tappable → User Profile View |
| `<EncryptionIndicator>` | lock icon — shows active scheme (data vs. ratchet) |

---

## Feature Scope (v1)

### In Scope
- Biometric login (iOS Keychain / Android Keystore)
- Username + avatar + bio + available_for profile
- Org creation with custom type labels (Pack, Collective, Commune, etc.)
- NFC (in-person) + QR code org membership
- `p2panda-auth` DAG membership with Pull/Read/Write/Manage levels
- Group-encrypted room with data scheme (historical access for late joiners)
- Room messaging: text, @mentions, emoji, GIF (Tenor), rich link embeds
- Media attachments (images, video) via p2panda-blobs
- Push-to-talk voice messages via p2panda-blobs (Opus audio)
- Reactions (emoji, CRDT)
- 1:1 DMs via X3DH key exchange + Double Ratchet (message scheme)
- Activity feed (Home tab)
- User profile view (About, username, avatar, public key, orgs, available_for)
- Org profile view (name, type_label, description, members, join/invite)
- Public org discovery via DHT
- Seed phrase recovery / multi-device import

### Out of Scope (v1)
- Live voice/video channels (deferred to v2)
- Multiple rooms per org (starts with one "general" room; can be added later by Manage members)
- Custom emoji
- Message threads/sub-threads
- File sharing beyond images/audio/video

---

## Open Questions

1. **Tenor vs. Giphy**: Tenor has a free API tier; Giphy requires a key but has broader reach. Either can plug into `<embed_url>` field with no data model changes.
2. **Bootstrap node infrastructure**: Who runs the initial bootstrap nodes? Community-run vs. Delta-operated for launch.
3. **Push notifications**: P2P apps have no central server to send APNs/FCM. Options: (a) background sync polling, (b) opt-in relay for notifications only, (c) no notifications until app opens. Needs a decision before v1 ships.
4. **Invite link expiry**: How long should QR invite tokens be valid? (Suggested: 24h, configurable by org admin.)

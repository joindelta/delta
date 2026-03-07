# Ignore, DND, Message Requests & Auto Key Rotation — Design

**Date:** 2026-03-07

## Overview

Three user-facing privacy and security features:

1. **Ignore** — users can silence specific public keys at the read layer (local-only, reversible).
2. **DND + Message Requests** — device-local notification suppression; messages from unknown senders are held in a requests inbox rather than delivered directly.
3. **Auto epoch bump on ban** — every ban event synchronously increments the encryption epoch on all rooms in the affected org, forcing key rotation for subsequent messages.

---

## Feature 1: Ignore

### Goal

A user can ignore any public key. Messages from that key are stored but never returned by `list_messages`, preserving the ability to un-ignore and recover history.

### DB

Additive migration adds one table to `read.db`:

```sql
CREATE TABLE IF NOT EXISTS ignored_keys (
    public_key TEXT PRIMARY KEY,
    ignored_at INTEGER NOT NULL
);
```

### Core (Rust)

**`db.rs`** — new helpers:
- `ignore_user(pool, public_key)` — upsert into `ignored_keys`
- `unignore_user(pool, public_key)` — delete from `ignored_keys`
- `list_ignored_users(pool)` — return all ignored keys
- `is_ignored(pool, public_key)` — boolean check

Modify `list_messages` query:
```sql
WHERE author_key NOT IN (SELECT public_key FROM ignored_keys)
```

No projector changes required — ignored messages are stored in full and filtering is purely at read time.

**`lib.rs`** — three new UniFFI-exposed functions:
- `ignore_user(public_key: String)`
- `unignore_user(public_key: String)`
- `list_ignored_users() -> Vec<String>`

### FFI (TypeScript)

Add to `gardensCore.ts`:
- `ignoreUser(publicKey: string): Promise<void>`
- `unignoreUser(publicKey: string): Promise<void>`
- `listIgnoredUsers(): Promise<string[]>`

### UI

- `MemberActionsSheet` — add Ignore / Unignore action (toggle based on current ignore state)
- `ProfileSheet` — add Ignore / Unignore action

---

## Feature 2: DND + Message Requests

### DND

A device-local notification preference. No DB table or sync needed.

- New `useSettingsStore.ts` backed by AsyncStorage
- State: `dndEnabled: boolean`, `setDnd(enabled: boolean): Promise<void>`
- Notification dispatch path checks `dndEnabled` before firing any push notification
- UI: toggle in `UserSettingsScreen` under a new "Privacy" section

### Message Requests

#### Goal

Messages from public keys with no prior interaction (no existing DM thread, no mutual org membership) are held as requests rather than delivered directly to the inbox.

#### DB

Additive migration:
```sql
ALTER TABLE dm_threads ADD COLUMN is_request INTEGER NOT NULL DEFAULT 0;
```

#### Projector logic

When projecting a `create_dm_thread` op where the initiator is not the local user:

1. Does an existing DM thread already exist with this initiator key? → `is_request = 0`
2. Is this initiator key a member of any org the local user belongs to? → `is_request = 0`
3. Otherwise → `is_request = 1`

#### Core (Rust)

New helper in `db.rs`:
- `is_known_sender(pool, public_key, local_key) -> bool` — checks conditions 1 and 2 above

New UniFFI-exposed functions in `lib.rs`:
- `accept_message_request(thread_id: String)` — sets `is_request = 0`
- `decline_message_request(thread_id: String)` — deletes thread and all its messages

#### FFI (TypeScript)

- `DmThread` type gains `isRequest: boolean`
- Add `acceptMessageRequest(threadId: string): Promise<void>`
- Add `declineMessageRequest(threadId: string): Promise<void>`

#### App layer

- `useDMStore` exposes two derived arrays: `threads` (accepted) and `requests` (pending)
- `InboxScreen.tsx` renders a requests section with Accept / Decline per item
- Requests do not trigger notifications regardless of DND state

---

## Feature 3: Auto Epoch Bump on Ban

### Goal

Every ban synchronously increments `enc_key_epoch` on all rooms in the affected org. Because every member's device projects the same ban op, every device arrives at the same epoch deterministically — no additional gossip ops required.

### ops.rs

Add `BanMemberOp`:
```rust
pub struct BanMemberOp {
    pub op_type: String,  // "ban_member"
    pub org_id: String,
    pub member_key: String,
}
```

Add `log_ids::MEMBERSHIP` dispatch for ban ops (currently a stub).

### Projector

In the `MEMBERSHIP` log handler, when `op_type == "ban_member"`:
1. Update `memberships` table to record the ban
2. Call `bump_room_epochs_for_org(pool, org_id)`

```rust
async fn bump_room_epochs_for_org(pool: &SqlitePool, org_id: &str) {
    sqlx::query(
        "UPDATE rooms SET enc_key_epoch = enc_key_epoch + 1 WHERE org_id = ?"
    )
    .bind(org_id)
    .execute(pool)
    .await;
}
```

### lib.rs

`ban_member` (currently stub) is implemented to emit a signed `BanMemberOp` into the `MEMBERSHIP` log, replacing the stub.

### Determinism guarantee

All peers project ops in log order. The ban op carries the `org_id`. Every peer that projects this op increments all room epochs by 1. No coordinator or additional signalling needed.

---

## Summary of DB changes

| Table | Change |
|---|---|
| `ignored_keys` | New table |
| `dm_threads` | Add `is_request INTEGER NOT NULL DEFAULT 0` |
| `rooms` | No schema change (`enc_key_epoch` already exists) |

## Summary of new FFI surface

| Function | Feature |
|---|---|
| `ignoreUser(publicKey)` | Ignore |
| `unignoreUser(publicKey)` | Ignore |
| `listIgnoredUsers()` | Ignore |
| `acceptMessageRequest(threadId)` | Message Requests |
| `declineMessageRequest(threadId)` | Message Requests |

## Files touched

- `core/src/db.rs` — new tables, helpers, modified `list_messages`
- `core/src/ops.rs` — new `BanMemberOp`
- `core/src/projector.rs` — message request logic, ban handler + epoch bump
- `core/src/lib.rs` — new UniFFI exports, implement `ban_member`
- `app/src/ffi/gardensCore.ts` — new FFI wrappers + updated types
- `app/src/stores/useDMStore.ts` — split threads/requests
- `app/src/stores/useSettingsStore.ts` — new (DND)
- `app/src/screens/UserSettingsScreen.tsx` — DND toggle
- `app/src/screens/InboxScreen.tsx` — requests UI
- `app/src/sheets/MemberActionsSheet.tsx` — ignore action
- `app/src/sheets/ProfileSheet.tsx` — ignore action

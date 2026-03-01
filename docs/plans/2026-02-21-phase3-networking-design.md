# Delta — Phase 3 Networking Design
**Date:** 2026-02-21
**Status:** Approved

---

## Overview

Phase 3 adds p2panda-net to core, giving Delta real-time gossip delivery and offline-resilient LogSync catch-up. p2panda is used as an offline-first backhaul — the app is always network-enabled when a connection is available, and LogSync handles catch-up automatically on reconnect.

---

## Architecture

A new `NetworkCore` singleton is added to `core` alongside the existing `DeltaCore`. Both are initialized inside `bootstrap()` — React Native only calls `init_core()` once.

```
core/src/
  network.rs     ← new: NetworkCore singleton, init_network(), topic helpers
  store.rs       ← existing: bootstrap() extended to call init_network()
  ops.rs         ← existing: publish() extended to gossip after writing to store
  projector.rs   ← existing: unchanged (LogSync feeds DeltaStore, projector polls it)
```

### Data Flow

```
[WRITE PATH — local op]
ops::publish()
  → insert into DeltaStore (p2panda-store)
  → fire-and-forget: gossip_handle.publish(op_bytes)

[WRITE PATH — remote op via LogSync]
LogSync syncs remote author logs → DeltaStore
  → projector 500ms poll picks up new ops automatically

[READ PATH — unchanged]
Projector → decode CBOR → upsert read model → UniFFI queries
```

LogSync writes into the same `DeltaStore` the projector already polls. Remote ops arrive for free with no projector changes.

---

## Topic Scheme

Three topic scopes, each a deterministic 32-byte `Hash` all parties derive independently:

```
Org meta topic:  TopicId = Hash(b"delta:org:"  + org_id_bytes)
Room topic:      TopicId = Hash(b"delta:room:" + room_id_bytes)
DM topic:        TopicId = Hash(b"delta:dm:"   + sort(key_a, key_b))
```

The `"delta:"` prefix namespaces topics away from other p2panda apps on the same network.

### TopicMap (LogSync)

| Topic | Log IDs synced |
|---|---|
| Org meta | `profile`, `org`, `room` for all known org members |
| Room | `message`, `reaction` for known room members |
| DM thread | `dm_thread`, `message` for both parties |

### Startup Subscription Sequence

```
bootstrap() completes
  → query read model: list all orgs I'm a member of
      → subscribe to org meta topic per org
      → for each org, list rooms I'm in
          → subscribe to room topic per room
  → query read model: list all DM threads
      → subscribe to DM topic per thread
```

New topics are subscribed immediately at runtime:
- `subscribe_room_topic(room_id)` called after `create_room()`
- `subscribe_dm_topic(thread_id)` called after `create_dm_thread()`

---

## NetworkCore Struct

```rust
pub struct NetworkCore {
    pub address_book: AddressBook,
    pub endpoint: Endpoint,
    pub gossip: Gossip,
    pub sync: LogSync<DeltaStore, String, ()>,
    pub sync_handles: Mutex<HashMap<[u8; 32], SyncHandle>>,
    pub gossip_handles: Mutex<HashMap<[u8; 32], GossipHandle>>,
}

static NETWORK: OnceLock<NetworkCore> = OnceLock::new();
```

### Bootstrap Node Config

Passed in from React Native via `init_core()`. RN holds a `BOOTSTRAP_NODES` constant in `ffi/deltaCore.ts` — keeps the Rust layer config-agnostic and allows bootstrap node updates without a native rebuild.

```rust
pub struct BootstrapNode {
    pub node_id_hex: String,   // Ed25519 pubkey hex
    pub relay_url: String,     // e.g. "https://relay.delta.app"
}
```

`init_core()` gains a `bootstrap_nodes: Vec<BootstrapNode>` parameter.

---

## Public Org Discovery

p2panda-net's confidential topic discovery (Private Set Intersection) is repurposed for public org indexing.

### Publishing a public org

When `create_org(is_public: true)`, subscribe to a discovery topic derived from the org name:

```
Discovery topic: TopicId = Hash(b"delta:discover:" + lowercase_normalized_name)
```

Any node subscribed to the same discovery topic is findable by searchers. The actual `org_id` and `OrgSummary` are gossiped to connecting peers — Discovery only handles the rendezvous.

### Searching

`search_public_orgs(query)` derives candidate topic IDs from query tokens, subscribes temporarily to those discovery topics, collects `OrgSummary` results gossiped by peers (5s timeout), then unsubscribes.

**Phase 3 limitations (acceptable for launch):**
- Token-exact search only (no fuzzy matching)
- Results require at least one org member online during the search window
- Spam/sybil resistance deferred to Phase 5 (membership + auth)

---

## UniFFI Additions

```
init_core(private_key_hex, db_dir, bootstrap_nodes: Vec<BootstrapNode>) -> Result<(), CoreError>
get_connection_status() -> ConnectionStatus   // enum: Online | Connecting | Offline
subscribe_room_topic(room_id: String) -> Result<(), CoreError>
subscribe_dm_topic(thread_id: String) -> Result<(), CoreError>
search_public_orgs(query: String) -> Vec<OrgSummary>
```

---

## React Native Additions

### `useNetworkStore` (Zustand)

Polls `get_connection_status()` every 3 seconds. Exposes `status: "online" | "connecting" | "offline"`.

### `<ConnectionBadge>`

Persistent chip in the navigation header. No dedicated screen.

```
Online      → green dot
Connecting  → amber dot + spinner
Offline     → grey dot
```

### Discover Orgs Screen

Reachable from "+" on the Orgs tab.

```
[ Search box ]
     ↓ on submit
search_public_orgs(query) → 5s loading state
     ↓
FlatList of OrgSummary cards
  [ avatar | name | type_label | description ]
  [ Join button → "Coming soon" toast (Phase 5 wires this up) ]
```

### Updated call sites

- `init_core()` in `ffi/deltaCore.ts` passes `BOOTSTRAP_NODES` constant
- `useOrgsStore.createRoom()` calls `subscribe_room_topic(room_id)` after success
- `useDMStore.createThread()` calls `subscribe_dm_topic(thread_id)` after success

---

## Files Changed / Added

### Rust
- `core/src/network.rs` — full implementation (replaces stub)
- `core/src/store.rs` — `bootstrap()` calls `init_network()`
- `core/src/ops.rs` — `publish()` gossips after store insert
- `core/src/lib.rs` — new UniFFI functions + `BootstrapNode` dict + `ConnectionStatus` enum
- `core/src/delta_core.udl` — new functions + types

### React Native
- `app/src/stores/useNetworkStore.ts` — new
- `app/src/components/ConnectionBadge.tsx` — new
- `app/src/screens/DiscoverOrgsScreen.tsx` — new
- `app/src/ffi/deltaCore.ts` — updated signatures + `BOOTSTRAP_NODES`
- `app/src/stores/useOrgsStore.ts` — calls `subscribe_room_topic`
- `app/src/stores/useDMStore.ts` — calls `subscribe_dm_topic`

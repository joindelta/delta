# Delta — Durable Object Sync + Onion Routing Design

**Date:** 2026-03-01
**Status:** Approved

---

## Overview

Replace `p2panda-net` (iroh/QUIC P2P transport) with Cloudflare Durable Objects as the message relay and sync backhaul. All messages route through onion-encrypted relay Workers before reaching the DO, preserving sender privacy. The p2panda data model (core, store, auth, encryption, blobs) is unchanged.

---

## Architecture

```
Mobile app
  │
  │  builds onion packet (buildOnionPacket FFI)
  │  POSTs to first relay hop
  ▼
Relay Worker (/hop) → Relay Worker (/hop) → ... → Relay Worker (/hop)
                                                          │
                                              peels Deliver layer
                                              calls Sync Worker via service binding
                                                          │
                                                          ▼
                                              Sync Worker (POST /deliver)
                                                          │
                                              routes to TopicDO by topic_id
                                                          │
                                                          ▼
                                              TopicDO — stores op, fans out
                                                          │
                                              WebSocket push to all connected clients
                                                          ▼
                                                    Mobile app
```

Two Cloudflare Workers:

- **Relay Worker** (`relay/`) — onion peeling only. Final `Deliver` hop calls Sync Worker via service binding. `IROH_BRIDGE_URL` removed.
- **Sync Worker** (`sync/`) — new. Owns `TopicDO` namespace. Handles WebSocket connections from clients and `POST /deliver` from the relay.

---

## TopicDO (Durable Object)

One DO instance per topic, named by the 32-byte topic ID hex.

### Storage

```
"seq"       → u64  (monotonic counter)
"head"      → u64  (highest seq written)
"op:<seq>"  → bytes (raw p2panda op)
```

Buffer capped at 1000 ops (~1MB per topic at typical op sizes). On overflow, oldest entry evicted.

### In-memory state

```ts
connections: Map<WebSocket, { lastSeq: number }>
```

Lost on DO hibernation — clients reconnect automatically.

### On WebSocket connect

1. Upgrade connection at `GET /topic/<topic-hex>?since=<seq>`
2. Replay all buffered ops from `since` to `head` in sequence order
3. Send `{ type: "ready", head }` to signal catch-up complete
4. Add client to live connection map
5. Push new ops as they arrive

### On op received (WebSocket or POST /deliver)

1. Increment `seq`, persist `op:<seq>` → bytes
2. Fan out raw bytes to all connected WebSocket clients
3. Sender receives their own op back — p2panda-core deduplicates on insert

---

## WebSocket Protocol

**Endpoint:** `GET wss://sync.delta.app/topic/<topic-hex>?since=<last_seq>`

### Client → DO
```ts
{ type: "op", data: "<base64>" }   // publish a new op
```

### DO → Client
```ts
{ type: "op",    seq: 42, data: "<base64>" }  // new or replayed op
{ type: "ready", head: 42 }                    // replay complete, now live
```

### Connection flow
```
Client connects with since=<last_known_seq>
DO replays ops from last_known_seq+1 to head
DO sends { type: "ready", head }
--- live from here ---
DO pushes { type: "op" } as new ops arrive
Client sends { type: "op" } to publish
```

`last_known_seq` is stored per-topic in the local SQLite database and updated as ops arrive.

---

## Onion Routing Integration

### Deliver payload wire format (updated)

```
TYPE=Deliver (0x02):
  [1..33]  topic_id: 32 bytes
  [33..]   op: raw p2panda op bytes
```

Replaces the previous `destination_node_id` + `message` format.

### Send path

1. App resolves relay pkarr records → `OnionHopFfi[]` (via `useRelayStore`, already implemented)
2. App calls `buildOnionPacket(hops, topic_id, op_bytes)` FFI
3. App POSTs encrypted packet to `hops[0].nextUrl`
4. Each relay Worker peels one layer, forwards to next hop
5. Final relay Worker peels `Deliver` layer, calls Sync Worker via service binding: `POST /deliver { topic_id, op }`
6. Sync Worker routes to `TopicDO`, DO stores + fans out

Onion routing is mandatory — there is no direct WebSocket fast path.

---

## App Changes (Rust Core)

### Remove
- `p2panda-net` (iroh, QUIC, mDNS, gossip, LogSync transport)
- `network.rs`
- `iroh` direct dependency

### Keep (unchanged)
- `p2panda-core`, `p2panda-store`, `p2panda-auth`, `p2panda-encryption`, `p2panda-blobs`
- All op creation, signing, encryption
- Projector, read model, all SQLite queries
- Blob handling
- All UI screens

### Add
- `sync.rs` — WebSocket connection manager
  - One connection per subscribed topic
  - On connect: `GET /topic/<topic-hex>?since=<last_seq>`
  - Receives ops → `op_store.insert_operation()` → projector picks up automatically
  - Sends ops: after `ops::publish()` writes locally, `sync::send_op(topic_id, op_bytes)`
- `topic_seq` column in SQLite — tracks last seen `seq` per topic

### FFI surface changes
- `init_network(bootstrap_nodes)` → `init_sync(relay_hops, sync_url)`
- Gossip functions removed
- Connection status reflects WebSocket state

---

## Relay Worker Changes

- Update `onion.ts`: `Deliver` decode reads `topic_id[32]` instead of `destination_node_id[32]`
- Replace `IROH_BRIDGE_URL` fetch with service binding call to Sync Worker
- Remove `IROH_BRIDGE_URL` secret
- Add service binding to Sync Worker in `wrangler.toml`
- `/hop` endpoint logic unchanged

---

## What Stays the Same

| Component | Status |
|---|---|
| p2panda-core (ops, logs, hashing) | Unchanged |
| p2panda-store (SQLite op store) | Unchanged |
| p2panda-auth, encryption, blobs | Unchanged |
| Projector + read model | Unchanged |
| All React Native UI screens | Unchanged |
| sealed_sender (DM privacy) | Unchanged |
| pkarr identity + web gateway | Unchanged |
| Relay Worker `/hop` logic | Unchanged |
| Onion packet builder (Rust + FFI) | Unchanged |
| useRelayStore (pkarr relay discovery) | Unchanged |

---

## New Cloudflare Infrastructure

| Resource | Type | Purpose |
|---|---|---|
| `sync` Worker | Cloudflare Worker | WebSocket endpoint + /deliver handler |
| `TopicDO` | Durable Object | Per-topic op buffer + fan-out |
| Service binding `SYNC` | Relay → Sync | Final onion delivery |

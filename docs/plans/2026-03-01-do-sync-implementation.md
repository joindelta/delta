# DO Sync + Onion Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace p2panda-net with Cloudflare Durable Objects (TopicDO) as the message transport, with mandatory onion routing through relay Workers.

**Architecture:** A new Sync Worker owns `TopicDO` instances (one per topic). Mobile app manages WebSocket connections to topic DOs via React Native's built-in WebSocket API; received op bytes are passed to Rust via `ingest_op` FFI. Sending routes through onion-encrypted relay Workers — the final relay hop calls the Sync Worker via service binding, which delivers to the DO and fans out to connected clients.

**Tech Stack:** TypeScript Cloudflare Workers + Durable Objects, Vitest (DO tests), Rust (core), UniFFI, React Native WebSocket API, `@noble/curves`, `@noble/ciphers`

---

## Task 1: Rename Deliver payload fields across all layers

Rename `destination_node_id` → `topic_id` and `message` → `op` in the onion Deliver payload. Wire format is identical (32 bytes + N bytes) — this is a pure rename.

**Files:**
- Modify: `core/src/onion.rs`
- Modify: `core/src/lib.rs`
- Modify: `core/src/delta_core.udl`
- Modify: `relay/src/onion.ts`
- Modify: `relay/src/onion.test.ts`
- Modify: `app/src/ffi/deltaCore.ts`
- Modify: `app/src/utils/onionRoute.ts`

### Step 1: Update `core/src/onion.rs`

Find the `OnionPayload` enum and update the `Deliver` variant:

```rust
/// This hop is the exit — deliver `op` to the topic `topic_id`.
Deliver {
    topic_id: [u8; 32],
    op: Vec<u8>,
},
```

Update `encode_payload` match arm:
```rust
OnionPayload::Deliver { topic_id, op } => {
    let mut out = Vec::with_capacity(1 + 32 + op.len());
    out.push(0x02);
    out.extend_from_slice(topic_id);
    out.extend_from_slice(op);
    out
}
```

Update `decode_payload` match arm:
```rust
0x02 => {
    if bytes.len() < 1 + 32 {
        return Err(OnionError::InvalidPayload);
    }
    let mut topic_id = [0u8; 32];
    topic_id.copy_from_slice(&bytes[1..33]);
    let op = bytes[33..].to_vec();
    Ok(OnionPayload::Deliver { topic_id, op })
}
```

### Step 2: Run existing Rust onion tests to confirm they still pass

```bash
cd core && cargo test onion -- --nocapture
```

Expected: all 8 tests pass (payload encoding/decoding unchanged, just field names differ).

### Step 3: Update `core/src/lib.rs` — OnionPeeled FFI struct

Find `pub struct OnionPeeled` and update:

```rust
pub struct OnionPeeled {
    pub peel_type: String,
    pub next_hop_url: Option<String>,
    pub inner_packet: Option<Vec<u8>>,
    pub topic_id: Option<Vec<u8>>,   // was: destination_node_id
    pub op: Option<Vec<u8>>,          // was: message
}
```

Update `peel_onion_layer` function — the `Deliver` arm:
```rust
onion::OnionPayload::Deliver { topic_id, op } => Ok(OnionPeeled {
    peel_type: "deliver".to_string(),
    next_hop_url: None,
    inner_packet: None,
    topic_id: Some(topic_id.to_vec()),
    op: Some(op),
}),
```

Update `build_onion_packet` — parameter rename (no logic change, just variable names):
```rust
pub fn build_onion_packet(
    hops: Vec<OnionHopFfi>,
    topic_id: Vec<u8>,   // was: destination_node_id
    op: Vec<u8>,          // was: message
) -> Result<Vec<u8>, OnionError> {
    if topic_id.len() != 32 {
        return Err(OnionError::InvalidKey("topic_id must be 32 bytes".to_string()));
    }
    let mut tid = [0u8; 32];
    tid.copy_from_slice(&topic_id);
    // ... rest unchanged, replace node_id with tid, message with op
```

### Step 4: Update `core/src/delta_core.udl`

Find `OnionPeeled` dictionary and update:
```udl
dictionary OnionPeeled {
    string peel_type;
    string? next_hop_url;
    bytes? inner_packet;
    bytes? topic_id;   // was: destination_node_id
    bytes? op;          // was: message
};
```

Update `build_onion_packet` signature:
```udl
[Throws=OnionError]
bytes build_onion_packet(
    sequence<OnionHopFfi> hops,
    bytes topic_id,
    bytes op
);
```

### Step 5: Update `relay/src/onion.ts`

Update the `OnionPayload` union type:
```ts
export type OnionPayload =
  | { type: 'forward'; nextHopUrl: string; innerPacket: Uint8Array }
  | { type: 'deliver'; topicId: Uint8Array; op: Uint8Array };
```

Update `decodePayload` — the `0x02` branch:
```ts
if (type === 0x02) {
  if (bytes.length < 1 + 32) throw new Error('Deliver payload too short');
  const topicId = bytes.slice(1, 33);
  const op = bytes.slice(33);
  return { type: 'deliver', topicId, op };
}
```

Update `buildTestPacket` — the `deliver` branch:
```ts
} else {
  const topicId = randomBytes(32);
  const op = new TextEncoder().encode('hello delta');
  plaintext = new Uint8Array(1 + 32 + op.length);
  plaintext[0] = 0x02;
  plaintext.set(topicId, 1);
  plaintext.set(op, 33);
  extras = { expectedTopicId: topicId, expectedOp: op };
}
```

Update the return type and `extras` object accordingly:
```ts
expectedTopicId?: Uint8Array;
expectedOp?: Uint8Array;
```

### Step 6: Update `relay/src/onion.test.ts`

Find the deliver test assertions — replace `expectedNodeId`/`expectedMessage` with `expectedTopicId`/`expectedOp`:
```ts
expect(payload.type).toBe('deliver');
if (payload.type === 'deliver') {
  expect(payload.topicId).toEqual(result.expectedTopicId);
  expect(payload.op).toEqual(result.expectedOp);
}
```

### Step 7: Run relay tests

```bash
cd relay && npx vitest run
```

Expected: all 10 tests pass.

### Step 8: Update `app/src/ffi/deltaCore.ts`

Update `OnionPeeled` interface:
```ts
export interface OnionPeeled {
  peelType: 'forward' | 'deliver';
  nextHopUrl: string | null;
  innerPacket: Uint8Array | null;
  topicId: Uint8Array | null;   // was: destinationNodeId
  op: Uint8Array | null;         // was: message
}
```

Update the native module interface — find `NativeInterface` definition:
```ts
buildOnionPacket(hops: OnionHopFfi[], topicIdBase64: string, opBase64: string): Promise<string>;
peelOnionLayer(packet: string, recipientSeedHex: string): Promise<{
  peelType: string;
  nextHopUrl: string | null;
  innerPacketBase64: string | null;
  topicIdBase64: string | null;  // was: destinationNodeIdBase64
  opBase64: string | null;        // was: messageBase64
}>;
```

Update `buildOnionPacket` wrapper:
```ts
export async function buildOnionPacket(
  hops: OnionHopFfi[],
  topicId: Uint8Array,
  op: Uint8Array,
): Promise<Uint8Array> {
  const base64 = await native.buildOnionPacket(hops, bytesToBase64(topicId), bytesToBase64(op));
  return base64ToBytes(base64);
}
```

Update `peelOnionLayer` wrapper — the return mapping:
```ts
return {
  peelType: raw.peelType as 'forward' | 'deliver',
  nextHopUrl: raw.nextHopUrl,
  innerPacket: raw.innerPacketBase64 ? base64ToBytes(raw.innerPacketBase64) : null,
  topicId: raw.topicIdBase64 ? base64ToBytes(raw.topicIdBase64) : null,
  op: raw.opBase64 ? base64ToBytes(raw.opBase64) : null,
};
```

### Step 9: Update `app/src/utils/onionRoute.ts`

Update `sendOnionMessage` — rename parameter and update call:
```ts
export async function sendOnionMessage(
  hops: OnionHopFfi[],
  topicId: Uint8Array,   // was: destNodeIdHex: string
  opBytes: Uint8Array,   // was: messageBytes
): Promise<void> {
  if (hops.length === 0) throw new Error('need at least one relay hop');
  if (topicId.length !== 32) throw new Error('topicId must be 32 bytes');

  const packet = await buildOnionPacket(hops, topicId, opBytes);

  const resp = await fetch(hops[0].nextUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: packet,
  });

  if (!resp.ok) throw new Error(`relay returned ${resp.status}`);
}
```

Remove the local `hexToBytes` helper at the bottom of the file — no longer needed.

### Step 10: Check for remaining `destNodeIdHex` / `destinationNodeId` / `message` references

```bash
grep -rn "destNodeIdHex\|destinationNodeId\|expectedNodeId\|expectedMessage\|IROH_BRIDGE" \
  core/src relay/src app/src --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.udl"
```

Expected: zero matches.

### Step 11: Build Rust to verify no compile errors

```bash
cd core && cargo build 2>&1 | grep -E "^error"
```

Expected: no errors.

### Step 12: Commit

```bash
git add core/src/onion.rs core/src/lib.rs core/src/delta_core.udl \
        relay/src/onion.ts relay/src/onion.test.ts \
        app/src/ffi/deltaCore.ts app/src/utils/onionRoute.ts
git commit -m "feat(onion): rename Deliver payload fields topic_id+op (was destination_node_id+message)"
```

---

## Task 2: Create Sync Worker with TopicDO

New Cloudflare Worker at `sync/`. Owns the `TopicDO` Durable Object. Handles WebSocket connections from mobile clients and `POST /deliver` from the relay.

**Files:**
- Create: `sync/package.json`
- Create: `sync/wrangler.toml`
- Create: `sync/tsconfig.json`
- Create: `sync/src/topic-do.ts`
- Create: `sync/src/index.ts`
- Create: `sync/src/topic-do.test.ts`

### Step 1: Write failing tests for TopicDO

Create `sync/src/topic-do.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal DO storage stub
function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> { return store.get(key) as T; },
    async put(key: string, value: unknown): Promise<void> { store.set(key, value); },
    async list<T>(opts: { prefix: string }): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (k.startsWith(opts.prefix)) result.set(k, v as T);
      }
      return result;
    },
  };
}

// Minimal WebSocket stub
function makeWs() {
  const sent: string[] = [];
  return {
    send: (msg: string) => { sent.messages = sent.messages ?? []; sent.push(msg); },
    readyState: 1, // OPEN
    accept: () => {},
    sent,
  };
}

describe('TopicDO', () => {
  it('stores an op and increments seq', async () => {
    const { TopicDO } = await import('./topic-do');
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    await do_.receiveOp(new Uint8Array([1, 2, 3]));

    const head = await storage.get<number>('head');
    expect(head).toBe(1);
    const op = await storage.get<string>('op:1');
    expect(op).toBeTruthy();
  });

  it('replays buffered ops on connect with since=0', async () => {
    const { TopicDO } = await import('./topic-do');
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    await do_.receiveOp(new Uint8Array([10, 20, 30]));
    await do_.receiveOp(new Uint8Array([40, 50, 60]));

    const ws = makeWs();
    await do_.handleWebSocket(ws as any, 0);

    expect(ws.sent.length).toBe(3); // 2 ops + ready
    const ready = JSON.parse(ws.sent[2]);
    expect(ready).toEqual({ type: 'ready', head: 2 });
  });

  it('only replays ops after since', async () => {
    const { TopicDO } = await import('./topic-do');
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    await do_.receiveOp(new Uint8Array([1]));
    await do_.receiveOp(new Uint8Array([2]));
    await do_.receiveOp(new Uint8Array([3]));

    const ws = makeWs();
    await do_.handleWebSocket(ws as any, 2);

    // only op:3 + ready
    expect(ws.sent.length).toBe(2);
    const ready = JSON.parse(ws.sent[1]);
    expect(ready.head).toBe(3);
  });

  it('evicts oldest op when buffer exceeds 1000', async () => {
    const { TopicDO, BUFFER_SIZE } = await import('./topic-do');
    expect(BUFFER_SIZE).toBe(1000);
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    for (let i = 0; i < 1001; i++) {
      await do_.receiveOp(new Uint8Array([i % 256]));
    }

    const op1 = await storage.get('op:1');
    expect(op1).toBeUndefined(); // evicted
    const op1001 = await storage.get('op:1001');
    expect(op1001).toBeTruthy();
  });
});
```

### Step 2: Run tests to confirm they fail

```bash
cd sync && npm install && npx vitest run src/topic-do.test.ts
```

Expected: FAIL — `Cannot find module './topic-do'`

### Step 3: Create scaffold files

Create `sync/package.json`:
```json
{
  "name": "@delta/sync-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241218.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

Create `sync/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

Create `sync/wrangler.toml`:
```toml
name = "delta-sync"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "TOPIC_DO"
class_name = "TopicDO"

[[migrations]]
tag = "v1"
new_classes = ["TopicDO"]
```

### Step 4: Implement `sync/src/topic-do.ts`

```ts
/**
 * TopicDO — one Durable Object instance per topic.
 *
 * Stores up to BUFFER_SIZE ops (rolling), fans out to connected WebSocket clients.
 *
 * Storage layout:
 *   "head"     → number   (highest seq written, 0 if empty)
 *   "op:<seq>" → string   (base64-encoded op bytes)
 */

export const BUFFER_SIZE = 1000;

interface WsClient {
  ws: WebSocket;
  lastSeq: number;
}

export class TopicDO {
  private storage: DurableObjectStorage;
  private clients: Set<WsClient> = new Set();

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const since = parseInt(url.searchParams.get('since') ?? '0', 10);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      (server as any).accept();
      await this.handleWebSocket(server as WebSocket, since);
      return new Response(null, { status: 101, webSocket: client });
    }

    // POST /deliver — from relay Worker via service binding
    if (request.method === 'POST' && url.pathname === '/deliver') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      await this.receiveOp(bytes);
      return new Response(null, { status: 200 });
    }

    return new Response('not found', { status: 404 });
  }

  /** Handle a new WebSocket connection. Replays buffered ops since `since`, then stays live. */
  async handleWebSocket(ws: WebSocket, since: number): Promise<void> {
    const head = (await this.storage.get<number>('head')) ?? 0;

    // Replay missed ops
    for (let seq = since + 1; seq <= head; seq++) {
      const data = await this.storage.get<string>(`op:${seq}`);
      if (data) ws.send(JSON.stringify({ type: 'op', seq, data }));
    }

    ws.send(JSON.stringify({ type: 'ready', head }));

    const client: WsClient = { ws, lastSeq: head };
    this.clients.add(client);

    ws.addEventListener('message', async (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'op' && typeof msg.data === 'string') {
          const bytes = base64ToBytes(msg.data);
          await this.receiveOp(bytes);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.addEventListener('close', () => {
      this.clients.delete(client);
    });

    ws.addEventListener('error', () => {
      this.clients.delete(client);
    });
  }

  /** Store op, fan out to all connected clients. */
  async receiveOp(bytes: Uint8Array): Promise<void> {
    const head = ((await this.storage.get<number>('head')) ?? 0) + 1;
    const data = bytesToBase64(bytes);

    await this.storage.put('head', head);
    await this.storage.put(`op:${head}`, data);

    // Evict oldest if over buffer limit
    if (head > BUFFER_SIZE) {
      await this.storage.delete(`op:${head - BUFFER_SIZE}`);
    }

    // Fan out to live clients
    const msg = JSON.stringify({ type: 'op', seq: head, data });
    for (const client of this.clients) {
      try {
        client.ws.send(msg);
        client.lastSeq = head;
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

### Step 5: Implement `sync/src/index.ts`

```ts
/**
 * Delta Sync Worker
 *
 * Endpoints:
 *   GET  /topic/<topic-hex>?since=<seq>  — WebSocket upgrade to TopicDO
 *   POST /deliver                         — from Relay Worker (service binding)
 */

import { TopicDO } from './topic-do';

export { TopicDO };

export interface Env {
  TOPIC_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // GET /topic/<topic-hex>
    if (parts[0] === 'topic' && parts[1]) {
      const topicHex = parts[1];
      if (!/^[0-9a-f]{64}$/i.test(topicHex)) {
        return new Response('invalid topic id', { status: 400 });
      }
      const id = env.TOPIC_DO.idFromName(topicHex);
      const stub = env.TOPIC_DO.get(id);
      return stub.fetch(request);
    }

    // POST /deliver { topic_hex, op_base64 }
    if (request.method === 'POST' && parts[0] === 'deliver') {
      const body = await request.json() as { topic_hex: string; op_base64: string };
      if (!body.topic_hex || !body.op_base64) {
        return new Response('missing fields', { status: 400 });
      }
      if (!/^[0-9a-f]{64}$/i.test(body.topic_hex)) {
        return new Response('invalid topic id', { status: 400 });
      }

      const id = env.TOPIC_DO.idFromName(body.topic_hex);
      const stub = env.TOPIC_DO.get(id);
      const bytes = base64ToBytes(body.op_base64);

      const deliverReq = new Request('https://do/deliver', {
        method: 'POST',
        body: bytes,
      });
      const resp = await stub.fetch(deliverReq);
      return new Response(null, { status: resp.ok ? 200 : 502 });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

### Step 6: Run tests

```bash
cd sync && npx vitest run
```

Expected: all 4 TopicDO tests pass.

### Step 7: Dry-run deploy

```bash
cd sync && npx wrangler deploy --dry-run
```

Expected: `Total Upload: N KiB` with no errors.

### Step 8: Commit

```bash
git add sync/
git commit -m "feat(sync): Sync Worker + TopicDO with op buffering and WebSocket fan-out"
```

---

## Task 3: Wire Relay Worker → Sync Worker

Replace the `IROH_BRIDGE_URL` fetch in the relay with a service binding call to the Sync Worker.

**Files:**
- Modify: `relay/wrangler.toml`
- Modify: `relay/src/index.ts`

### Step 1: Update `relay/wrangler.toml`

Add service binding after the existing config:

```toml
[[services]]
binding = "SYNC"
service = "delta-sync"
```

Remove the comment about `IROH_BRIDGE_URL` — it's no longer a secret.

### Step 2: Update `relay/src/index.ts` — Env interface

Add `SYNC` binding and remove `IROH_BRIDGE_URL`:

```ts
export interface Env {
  RELAY_SEED_HEX: string;
  SELF_URL?: string;
  SYNC: Fetcher;   // service binding to delta-sync Worker
}
```

### Step 3: Update the `deliver` branch in `relay/src/index.ts`

Find the `payload.type === 'deliver'` block and replace:

```ts
if (payload.type === 'deliver') {
  const topicHex = bytesToHex(payload.topicId);
  const opBase64 = uint8ArrayToBase64(payload.op);

  const resp = await env.SYNC.fetch('https://sync/deliver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic_hex: topicHex, op_base64: opBase64 }),
  });
  return new Response(null, { status: resp.ok ? 200 : 502 });
}
```

### Step 4: Run relay tests to confirm nothing broken

```bash
cd relay && npx vitest run
```

Expected: all 10 tests pass (deliver path isn't unit-tested — the service binding is integration-only).

### Step 5: Dry-run deploy

```bash
cd relay && npx wrangler deploy --dry-run
```

Expected: builds cleanly.

### Step 6: Commit

```bash
git add relay/wrangler.toml relay/src/index.ts
git commit -m "feat(relay): replace IROH_BRIDGE_URL with SYNC service binding for final delivery"
```

---

## Task 4: Add `ingest_op` + `topic_seq` to Rust core

Add a simple `sync.rs` module to the core that handles incoming ops from the DO WebSocket. React Native will call `ingest_op` for each op received. Also tracks last-seen seq per topic in SQLite for the `since` parameter on reconnect.

**Files:**
- Create: `core/src/sync.rs`
- Modify: `core/src/db.rs`
- Modify: `core/src/lib.rs`
- Modify: `core/src/delta_core.udl`

### Step 1: Write failing tests for sync.rs

Add to a new file `core/src/sync.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_hex_roundtrip() {
        let topic: [u8; 32] = [0xab; 32];
        let hex = bytes_to_hex(&topic);
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
```

Run:
```bash
cd core && cargo test sync -- --nocapture
```

Expected: FAIL — module doesn't exist yet.

### Step 2: Add `topic_seq` table migration to `core/src/db.rs`

Find the schema initialization function (look for `CREATE TABLE IF NOT EXISTS`) and add:

```rust
sqlx::query(
    "CREATE TABLE IF NOT EXISTS topic_seq (
        topic_hex TEXT PRIMARY KEY,
        last_seq  INTEGER NOT NULL DEFAULT 0
    )"
)
.execute(pool)
.await?;
```

Add these query functions at the end of `db.rs`:

```rust
pub async fn get_topic_seq(pool: &SqlitePool, topic_hex: &str) -> Result<i64, sqlx::Error> {
    let row = sqlx::query_scalar::<_, i64>(
        "SELECT last_seq FROM topic_seq WHERE topic_hex = ?"
    )
    .bind(topic_hex)
    .fetch_optional(pool)
    .await?;
    Ok(row.unwrap_or(0))
}

pub async fn set_topic_seq(pool: &SqlitePool, topic_hex: &str, seq: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO topic_seq (topic_hex, last_seq) VALUES (?, ?)
         ON CONFLICT(topic_hex) DO UPDATE SET last_seq = excluded.last_seq"
    )
    .bind(topic_hex)
    .bind(seq)
    .execute(pool)
    .await?;
    Ok(())
}
```

### Step 3: Create `core/src/sync.rs`

```rust
//! Incoming op ingestion from the Sync Worker WebSocket.
//!
//! React Native manages the WebSocket connection. When an op arrives,
//! RN calls `ingest_op(topic_hex, seq, op_bytes)` which inserts it into
//! the DeltaStore. The projector picks it up within 500ms.

use crate::ops::{decode_cbor, GossipEnvelope};
use crate::store::get_core;
use p2panda_core::{Body, Header};

#[derive(Debug)]
pub struct SyncError(pub String);

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sync error: {}", self.0)
    }
}

impl std::error::Error for SyncError {}

/// Convert 32 raw bytes to a 64-char lowercase hex string.
pub fn bytes_to_hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Ingest a raw op received from the DO WebSocket.
///
/// `topic_hex` — 64-char hex topic ID (for seq tracking)
/// `seq`       — the DO sequence number for this op
/// `op_bytes`  — raw GossipEnvelope CBOR bytes
pub async fn ingest_op(topic_hex: &str, seq: i64, op_bytes: &[u8]) -> Result<(), SyncError> {
    let core = get_core().ok_or_else(|| SyncError("core not initialised".into()))?;

    // Decode GossipEnvelope CBOR
    let env = decode_cbor::<GossipEnvelope>(op_bytes)
        .map_err(|e| SyncError(format!("decode: {e}")))?;

    let header = Header::try_from(env.header_bytes.as_slice())
        .map_err(|e| SyncError(format!("header: {e}")))?;
    let body = Body::new(&env.body_bytes);
    let op_hash = header.hash();

    // Insert into store — duplicate inserts are silently ignored
    {
        let mut store = core.op_store.lock().await;
        store
            .insert_operation(op_hash, &header, Some(&body), &env.header_bytes, &env.log_id)
            .await
            .map_err(|e| SyncError(format!("insert: {e}")))?;
    }

    // Update last-seen seq for this topic
    crate::db::set_topic_seq(&core.read_pool, topic_hex, seq)
        .await
        .map_err(|e| SyncError(format!("seq: {e}")))?;

    Ok(())
}

/// Get the last-seen seq for a topic (for the WebSocket `since` parameter).
pub async fn get_topic_seq(topic_hex: &str) -> Result<i64, SyncError> {
    let core = get_core().ok_or_else(|| SyncError("core not initialised".into()))?;
    crate::db::get_topic_seq(&core.read_pool, topic_hex)
        .await
        .map_err(|e| SyncError(format!("seq: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_hex_roundtrip() {
        let topic: [u8; 32] = [0xab; 32];
        let hex = bytes_to_hex(&topic);
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(hex.starts_with("ab"));
    }
}
```

### Step 4: Add `pub mod sync;` to `core/src/lib.rs`

Find the existing `pub mod` declarations near the top and add:
```rust
pub mod sync;
```

### Step 5: Run sync tests

```bash
cd core && cargo test sync -- --nocapture
```

Expected: 1 test passes.

### Step 6: Add FFI wrappers to `core/src/lib.rs`

Add a `SyncError` UDL error enum wrapper and two FFI functions. Find the section near `OnionError` and add:

```rust
// ── Sync ──────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SyncFfiError {
    #[error("{0}")]
    Error(String),
}

pub fn ingest_op_ffi(topic_hex: String, seq: i64, op_bytes: Vec<u8>) -> Result<(), SyncFfiError> {
    store::block_on(async move {
        sync::ingest_op(&topic_hex, seq, &op_bytes)
            .await
            .map_err(|e| SyncFfiError::Error(e.0))
    })
}

pub fn get_topic_seq_ffi(topic_hex: String) -> Result<i64, SyncFfiError> {
    store::block_on(async move {
        sync::get_topic_seq(&topic_hex)
            .await
            .map_err(|e| SyncFfiError::Error(e.0))
    })
}
```

### Step 7: Update `core/src/delta_core.udl`

Add after the `OnionError` section:

```udl
// ── Sync ──────────────────────────────────────────────────────────────────────

[Error]
enum SyncFfiError { "Error" };

namespace delta_core {
    // ... existing functions ...

    [Throws=SyncFfiError]
    void ingest_op_ffi(string topic_hex, i64 seq, bytes op_bytes);

    [Throws=SyncFfiError]
    i64 get_topic_seq_ffi(string topic_hex);
};
```

Note: add these two functions inside the existing `namespace delta_core { }` block, don't create a new one.

### Step 8: Build to verify

```bash
cd core && cargo build 2>&1 | grep -E "^error"
```

Expected: no errors.

### Step 9: Commit

```bash
git add core/src/sync.rs core/src/db.rs core/src/lib.rs core/src/delta_core.udl
git commit -m "feat(sync): ingest_op + get_topic_seq FFI for WebSocket-driven op ingestion"
```

---

## Task 5: Remove p2panda-net from Rust core, update send path

Remove iroh/p2panda-net. Replace gossip send calls with returning op bytes to the caller. Delete `network.rs`.

**Files:**
- Modify: `core/Cargo.toml`
- Modify: `core/src/lib.rs`
- Modify: `core/src/store.rs`
- Modify: `core/src/ops.rs`
- Delete: `core/src/network.rs`

### Step 1: Write a test confirming publish still works post-removal

Add to `core/src/lib.rs` tests section (there should be existing tests — find them):

```rust
// This test verifies publish compiles and returns op bytes after network removal.
// Run: cargo test publish_returns_bytes -- --nocapture
```

(This is a compile-time check more than a runtime test — the existing tests cover the logic.)

### Step 2: Remove deps from `core/Cargo.toml`

Remove these lines:
```toml
p2panda-net = "0.5"
p2panda-sync = "0.5"
# iroh (transitively pulled by p2panda-net, but we use types directly)
iroh = { version = "0.96", default-features = false }
```

### Step 3: Delete `core/src/network.rs`

```bash
rm core/src/network.rs
```

### Step 4: Update `core/src/lib.rs` — remove network module and gossip calls

Remove: `pub mod network;` from the module declarations.

Replace every `network::gossip_plain(...)` call with a no-op comment:
```rust
// op delivered via onion routing from the app layer
```

Replace every `network::gossip_dm_sealed(...)` call with a no-op comment:
```rust
// DM delivered via onion routing from the app layer
```

Remove calls to `network::subscribe_org_meta`, `network::subscribe_room`, `network::subscribe_dm_thread` — these are now handled by the React Native `useSyncStore`.

Update `connection_status()`:
```rust
pub fn connection_status() -> crate::ConnectionStatus {
    // Network status is managed by the RN sync layer
    crate::ConnectionStatus::Online
}
```

Remove `subscribe_room_topic` and `subscribe_dm_topic` FFI functions — RN manages subscriptions directly.

Remove from UDL: `subscribe_room_topic`, `subscribe_dm_topic` function declarations.

### Step 5: Update `core/src/store.rs` — remove `init_network` call

Find the `bootstrap()` function and remove the block:
```rust
// Bring up the network node.
crate::network::init_network(...)
```

Update `initCore` in `lib.rs` — remove `bootstrapNodes` parameter:
```rust
pub fn init_core(private_key_hex: String, db_dir: String) -> Result<(), CoreError> {
```

Update UDL:
```udl
void init_core(string private_key_hex, string db_dir);
```

### Step 6: Update `core/src/ops.rs`

The `GossipEnvelope` struct and `sign_and_store_op` / `encode_gossip_envelope` functions are still needed — `sync.rs` uses `GossipEnvelope` for decoding incoming ops. Keep them. Remove any imports of `network::` if present.

### Step 7: Build

```bash
cd core && cargo build 2>&1 | grep -E "^error"
```

Fix any remaining `network::` references (run `grep -rn "network::" core/src/` to find them).

### Step 8: Run all core tests

```bash
cd core && cargo test -- --nocapture 2>&1 | tail -20
```

Expected: all tests pass.

### Step 9: Commit

```bash
git add core/Cargo.toml core/src/lib.rs core/src/store.rs core/src/ops.rs core/src/delta_core.udl
git rm core/src/network.rs
git commit -m "feat(core): remove p2panda-net/iroh, send path now via onion routing from RN layer"
```

---

## Task 6: Update TypeScript FFI bindings

Reflect the UDL changes (removed bootstrap/subscribe FFI, added sync FFI) in the TypeScript bridge.

**Files:**
- Modify: `app/src/ffi/deltaCore.ts`

### Step 1: Update `NativeInterface` in `deltaCore.ts`

Remove:
```ts
initCore(privateKeyHex: string, dbDir: string, bootstrapNodes: BootstrapNode[]): Promise<void>;
subscribeRoomTopic(roomId: string): Promise<void>;
subscribeDmTopic(threadId: string): Promise<void>;
```

Add:
```ts
initCore(privateKeyHex: string, dbDir: string): Promise<void>;
ingestOpFfi(topicHex: string, seq: number, opBytesBase64: string): Promise<void>;
getTopicSeqFfi(topicHex: string): Promise<number>;
```

### Step 2: Update the stub (test fallback) in `deltaCore.ts`

Find the stub object (the one with `async buildOnionPacket() { throw ... }`) and update:

Remove stub entries for `initCore`, `subscribeRoomTopic`, `subscribeDmTopic`.
Add:
```ts
async ingestOpFfi() { throw new Error('delta_core not loaded'); },
async getTopicSeqFfi() { throw new Error('delta_core not loaded'); },
```

Update `initCore` stub:
```ts
async initCore(_privateKeyHex: string, _dbDir: string) { throw new Error('delta_core not loaded'); },
```

### Step 3: Update `initCore` wrapper function

Find `export async function initCore(...)` and update:

```ts
export async function initCore(
  privateKeyHex: string,
  dbDir = '',
): Promise<void> {
  return native.initCore(privateKeyHex, dbDir);
}
```

Remove `BOOTSTRAP_NODES` constant and `BootstrapNode` interface — no longer needed.

### Step 4: Add sync wrapper functions

Add at the bottom of `deltaCore.ts`:

```ts
// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Ingest an op received from the DO WebSocket.
 * Called by useSyncStore when a { type: "op", seq, data } message arrives.
 */
export async function ingestOp(
  topicHex: string,
  seq: number,
  opBytes: Uint8Array,
): Promise<void> {
  return native.ingestOpFfi(topicHex, seq, bytesToBase64(opBytes));
}

/**
 * Get the last-seen seq for a topic (used as `since` param on WebSocket connect).
 */
export async function getTopicSeq(topicHex: string): Promise<number> {
  return native.getTopicSeqFfi(topicHex);
}
```

### Step 5: Fix any call sites that pass `bootstrapNodes`

```bash
grep -rn "initCore\|BOOTSTRAP_NODES\|subscribeRoomTopic\|subscribeDmTopic" \
  app/src --include="*.ts" --include="*.tsx"
```

Update each call site — remove `bootstrapNodes` argument, remove subscribe calls.

### Step 6: TypeScript compile check

```bash
cd app && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

### Step 7: Commit

```bash
git add app/src/ffi/deltaCore.ts
git commit -m "feat(app): update FFI bindings — remove bootstrap/subscribe, add ingestOp/getTopicSeq"
```

---

## Task 7: Create `useSyncStore` — React Native WebSocket manager

Manages one WebSocket connection per subscribed topic. Receives ops from DO, calls `ingestOp` FFI. Called from wherever topics are subscribed (rooms, DMs, orgs).

**Files:**
- Create: `app/src/stores/useSyncStore.ts`
- Modify: `app/src/screens/OrgChatScreen.tsx` (subscribe on mount)

### Step 1: Create `app/src/stores/useSyncStore.ts`

```ts
/**
 * useSyncStore — manages WebSocket connections to TopicDO instances.
 *
 * One WebSocket per subscribed topic. Reconnects automatically with
 * exponential backoff. Calls ingestOp FFI for each received op.
 */

import { create } from 'zustand';
import { ingestOp, getTopicSeq } from '../ffi/deltaCore';

const SYNC_URL = 'wss://delta-sync.workers.dev'; // override via env/config

interface TopicState {
  ws: WebSocket | null;
  lastSeq: number;
  reconnectMs: number;
  ready: boolean;
}

interface SyncStore {
  topics: Map<string, TopicState>;
  syncUrl: string;
  setSyncUrl: (url: string) => void;
  subscribe: (topicHex: string) => void;
  unsubscribe: (topicHex: string) => void;
  unsubscribeAll: () => void;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  topics: new Map(),
  syncUrl: SYNC_URL,

  setSyncUrl: (url) => set({ syncUrl: url }),

  subscribe: (topicHex: string) => {
    const { topics, syncUrl } = get();
    if (topics.has(topicHex)) return; // already subscribed

    const state: TopicState = { ws: null, lastSeq: 0, reconnectMs: 1000, ready: false };
    topics.set(topicHex, state);
    set({ topics: new Map(topics) });

    connect(topicHex, state, syncUrl, set, get);
  },

  unsubscribe: (topicHex: string) => {
    const { topics } = get();
    const state = topics.get(topicHex);
    if (state?.ws) {
      state.ws.onclose = null; // prevent reconnect
      state.ws.close();
    }
    topics.delete(topicHex);
    set({ topics: new Map(topics) });
  },

  unsubscribeAll: () => {
    const { topics } = get();
    for (const [, state] of topics) {
      if (state.ws) {
        state.ws.onclose = null;
        state.ws.close();
      }
    }
    set({ topics: new Map() });
  },
}));

async function connect(
  topicHex: string,
  state: TopicState,
  syncUrl: string,
  set: (s: Partial<SyncStore>) => void,
  get: () => SyncStore,
) {
  // Get last-seen seq from Rust (persisted across app restarts)
  try {
    state.lastSeq = await getTopicSeq(topicHex);
  } catch {
    state.lastSeq = 0;
  }

  const url = `${syncUrl}/topic/${topicHex}?since=${state.lastSeq}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'op' && typeof msg.seq === 'number' && typeof msg.data === 'string') {
        const bytes = base64ToBytes(msg.data);
        await ingestOp(topicHex, msg.seq, bytes);
        state.lastSeq = msg.seq;
      }

      if (msg.type === 'ready') {
        state.ready = true;
        state.reconnectMs = 1000; // reset backoff on successful connect
        const { topics } = get();
        set({ topics: new Map(topics) });
      }
    } catch {
      // ignore parse errors
    }
  };

  ws.onclose = () => {
    const { topics, syncUrl: currentUrl } = get();
    if (!topics.has(topicHex)) return; // unsubscribed

    // Exponential backoff reconnect (max 30s)
    const delay = Math.min(state.reconnectMs, 30_000);
    state.reconnectMs = Math.min(state.reconnectMs * 2, 30_000);
    state.ready = false;
    set({ topics: new Map(topics) });

    setTimeout(() => {
      if (get().topics.has(topicHex)) {
        connect(topicHex, state, currentUrl, set, get);
      }
    }, delay);
  };

  ws.onerror = () => {
    ws.close(); // triggers onclose → reconnect
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

### Step 2: Wire subscription into `OrgChatScreen.tsx`

Open `app/src/screens/OrgChatScreen.tsx`. Find the `useEffect` that initializes the screen. Add topic subscription:

```ts
import { useSyncStore } from '../stores/useSyncStore';
import { topicIdForRoom } from '../ffi/deltaCore'; // you'll add this below

// Inside the component:
const subscribe = useSyncStore(s => s.subscribe);
const unsubscribe = useSyncStore(s => s.unsubscribe);

useEffect(() => {
  if (!roomId) return;
  const topicHex = topicHexForRoom(roomId); // derive locally
  subscribe(topicHex);
  return () => unsubscribe(topicHex);
}, [roomId]);
```

Add `topicHexForRoom` helper in `deltaCore.ts` (derives the topic hex the same way Rust does):

```ts
import { createHash } from 'react-native-sha256'; // or use @noble/hashes

export function topicHexForRoom(roomId: string): string {
  // Matches: Hash(b"delta:room:" + room_id_bytes)
  // Use @noble/hashes since it's already in the dep tree
  const { sha256 } = require('@noble/hashes/sha256');
  const input = new TextEncoder().encode('delta:room:' + roomId);
  const hash = sha256(input);
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function topicHexForDm(keyA: string, keyB: string): string {
  const [lo, hi] = keyA <= keyB ? [keyA, keyB] : [keyB, keyA];
  const input = new TextEncoder().encode(`delta:dm:${lo}:${hi}`);
  const { sha256 } = require('@noble/hashes/sha256');
  const hash = sha256(input);
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

Note: `@noble/hashes` is already a transitive dep. Verify with `ls app/node_modules/@noble/hashes` before adding a new dep.

### Step 3: Wire into DM screens

In `app/src/screens/` find the DM conversation screen. Apply the same pattern using `topicHexForDm(myKey, recipientKey)`.

### Step 4: TypeScript compile check

```bash
cd app && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

### Step 5: Commit

```bash
git add app/src/stores/useSyncStore.ts app/src/screens/OrgChatScreen.tsx app/src/ffi/deltaCore.ts
git commit -m "feat(app): useSyncStore WebSocket manager + topic subscription on chat screens"
```

---

## Task 8: Update `sendOnionMessage` call sites

Update every place that calls `sendOnionMessage` to pass `topicId: Uint8Array` instead of `destNodeIdHex: string`.

**Files:**
- Modify: `app/src/stores/useRelayStore.ts`
- Any other call sites found by grep

### Step 1: Find all call sites

```bash
grep -rn "sendOnionMessage" app/src --include="*.ts" --include="*.tsx"
```

### Step 2: Update `useRelayStore.ts`

Open `app/src/stores/useRelayStore.ts`. Find calls to `sendOnionMessage`. Update to pass the topic ID bytes instead of `destNodeIdHex`:

Before:
```ts
await sendOnionMessage(hops, destNodeIdHex, messageBytes);
```

After:
```ts
import { topicHexForRoom } from '../ffi/deltaCore';

// Derive topic bytes from the room/DM context
const topicHex = topicHexForRoom(roomId); // or topicHexForDm(...)
const topicId = hexToBytes(topicHex);
await sendOnionMessage(hops, topicId, opBytes);
```

The `hexToBytes` helper is already in `app/src/utils/onionRoute.ts` — but we removed it in Task 1. Re-add it as a named export, or import from `@noble/hashes/utils`.

Add to `app/src/utils/onionRoute.ts`:
```ts
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
```

### Step 3: Final compile check

```bash
cd app && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

### Step 4: Run relay tests one more time

```bash
cd relay && npx vitest run && cd ../sync && npx vitest run
```

Expected: all tests pass.

### Step 5: Final commit

```bash
git add app/src/stores/useRelayStore.ts app/src/utils/onionRoute.ts
git commit -m "feat(app): update sendOnionMessage call sites to use topic_id bytes"
```

---

## Deployment Checklist

After all tasks complete:

```bash
# 1. Deploy Sync Worker
cd sync && npx wrangler deploy

# 2. Deploy Relay Worker (now with service binding)
cd relay && npx wrangler deploy

# 3. Set relay secrets (RELAY_SEED_HEX, SELF_URL — IROH_BRIDGE_URL no longer needed)
# (SYNC service binding is automatic — no secret needed)

# 4. Build Android to verify Rust changes compile for mobile target
cd core && cargo build --target aarch64-linux-android
```

## Quick Reference

| Old | New |
|-----|-----|
| `destination_node_id` | `topic_id` |
| `message` (in Deliver) | `op` |
| `p2panda-net` / iroh | deleted |
| `network.rs` | deleted |
| `IROH_BRIDGE_URL` | `SYNC` service binding |
| `initCore(..., bootstrapNodes)` | `initCore(key, dbDir)` |
| `subscribeRoomTopic` FFI | `useSyncStore.subscribe(topicHex)` |
| gossip send in Rust | `sendOnionMessage` from RN |
| — | `sync/` Sync Worker (new) |
| — | `useSyncStore` (new) |
| — | `ingestOp` / `getTopicSeq` FFI (new) |

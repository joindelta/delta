# Relay Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the onion packet system end-to-end: Android bridge → Cloudflare Worker relay → pkarr relay discovery → app route selection.

**Architecture:** The Cloudflare Worker (`relay/`) acts as the onion relay hop: it receives an encrypted packet, peels one layer using the same crypto as the Rust core (ECDH X25519 → HKDF-SHA256 → XChaCha20-Poly1305), then either forwards the inner packet to the next hop or POSTs the plaintext message to an iroh delivery bridge. Each Worker has a persistent Ed25519 keypair (seed in `RELAY_SEED_HEX` secret) and publishes its public key to the pkarr DHT so the app can discover it. The app resolves relay pkarr records to build an `OnionHopFfi[]` list and calls the existing `buildOnionPacket` FFI, then POSTs the packet to the first hop.

**Tech Stack:** TypeScript Cloudflare Worker (`wrangler`), `@noble/curves` (X25519 / Ed25519 → Montgomery), `@noble/ciphers` (XChaCha20-Poly1305), `@noble/hashes` (HKDF-SHA256), `pkarr` npm package (DHT publishing), Vitest, Kotlin (Android bridge), Rust/`pkarr` crate (relay record parsing).

---

## Background

### Wire format recap

Every onion envelope (version `0x02`):
```
[0]      VERSION = 0x02
[1..33]  EPK     ephemeral X25519 public key (32 bytes)
[33..57] NONCE   XChaCha20-Poly1305 nonce (24 bytes)
[57..]   CIPHERTEXT  authenticated ciphertext (plaintext + 16-byte Poly1305 tag)
```

Decrypted payload byte 0 is the type:
- `0x01` = Forward: `url_len:u16 (big-endian) | url | inner_packet`
- `0x02` = Deliver: `destination_node_id[32] | message`

### HKDF info string
`b"delta:onion:v1"` — matches `HKDF_INFO` in `core/src/onion.rs`.

### Ed25519 → X25519 key conversion
Same as Rust `crypto.rs`:
```
ed25519_seed → SHA-512(seed)[0..32] + RFC 7748 clamp
ed25519_pubkey → CompressedEdwardsY.to_montgomery()
```
`@noble/curves/ed25519` exports `edwardsToMontgomeryPriv` and `edwardsToMontgomeryPub` which perform these exact conversions.

### pkarr relay record TXT format
```
v=delta1;t=relay;n=<hop_url>;a=<ed25519_pubkey_hex>
```
- `n` = relay hop URL (e.g. `https://relay1.delta.app/hop`)
- `a` = Worker's Ed25519 public key hex (32 bytes / 64 hex chars)

This reuses the existing `name` and `avatarBlobId` fields in `PkarrResolved` — no UDL changes needed.

---

## Task 1: Android Bridge for Onion Methods

The TypeScript interface already declares `buildOnionPacket` and `peelOnionLayer` but `DeltaCoreModule.kt` is missing the `@ReactMethod` implementations. Without them the app crashes at runtime on Android when these methods are called.

**Files:**
- Modify: `app/android/app/src/main/java/com/deltaapp/deltacore/DeltaCoreModule.kt`

### Step 1: Write the failing test (manual verification)

Open `app/android/` and note there are no unit tests for the bridge layer. We verify by build, not unit test here.

Confirm the gap:

```bash
grep -n "buildOnion\|peelOnion\|OnionHop" \
  app/android/app/src/main/java/com/deltaapp/deltacore/DeltaCoreModule.kt
```

Expected: no output (methods are absent).

### Step 2: Add the two `@ReactMethod` implementations

Open `DeltaCoreModule.kt`. After the closing brace of `getBlob` (around line 629), and **before** the `// ── Helpers` comment, insert:

```kotlin
  // ── Onion routing (bytes as base64 over the bridge) ───────────────────────

  @ReactMethod
  fun buildOnionPacket(
    hopsArray: ReadableArray,
    destinationNodeIdBase64: String,
    messageBase64: String,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        val hops = (0 until hopsArray.size()).map { i ->
          val map = hopsArray.getMap(i)!!
          uniffi.delta_core.OnionHopFfi(
            pubkeyHex = map.getString("pubkeyHex")!!,
            nextUrl   = map.getString("nextUrl")!!,
          )
        }
        val destBytes  = Base64.decode(destinationNodeIdBase64, Base64.DEFAULT)
        val msgBytes   = Base64.decode(messageBase64, Base64.DEFAULT)
        val packet     = uniffi.delta_core.buildOnionPacket(hops, destBytes, msgBytes)
        promise.resolve(Base64.encodeToString(packet, Base64.DEFAULT))
      } catch (e: Exception) {
        promise.reject("OnionError", e)
      }
    }
  }

  @ReactMethod
  fun peelOnionLayer(packetBase64: String, recipientSeedHex: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val packet = Base64.decode(packetBase64, Base64.DEFAULT)
        val peeled = uniffi.delta_core.peelOnionLayer(packet, recipientSeedHex)
        val map = Arguments.createMap()
        map.putString("peelType", peeled.peelType)
        peeled.nextHopUrl?.let { map.putString("nextHopUrl", it) }
          ?: map.putNull("nextHopUrl")
        peeled.innerPacket?.let {
          map.putString("innerPacketBase64", Base64.encodeToString(it, Base64.DEFAULT))
        } ?: map.putNull("innerPacketBase64")
        peeled.destinationNodeId?.let {
          map.putString("destinationNodeIdBase64", Base64.encodeToString(it, Base64.DEFAULT))
        } ?: map.putNull("destinationNodeIdBase64")
        peeled.message?.let {
          map.putString("messageBase64", Base64.encodeToString(it, Base64.DEFAULT))
        } ?: map.putNull("messageBase64")
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("OnionError", e)
      }
    }
  }
```

Also add to the top-level import block (with the other `uniffi.delta_core.*` imports):

```kotlin
import uniffi.delta_core.OnionHopFfi
```

### Step 3: Verify the build

```bash
cd app/android
./gradlew assembleDebug 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`. No `unresolved reference` errors.

### Step 4: Commit

```bash
cd app
git add android/app/src/main/java/com/deltaapp/deltacore/DeltaCoreModule.kt
git commit -m "feat(onion): Android bridge for buildOnionPacket and peelOnionLayer"
```

---

## Task 2: Cloudflare Worker Relay Package

Create `relay/` at the monorepo root. This is a standalone TypeScript Cloudflare Worker that peels onion layers and routes packets.

**Files:**
- Create: `relay/package.json`
- Create: `relay/tsconfig.json`
- Create: `relay/wrangler.toml`
- Create: `relay/src/crypto.ts`
- Create: `relay/src/onion.ts`
- Create: `relay/src/index.ts`
- Create: `relay/src/crypto.test.ts`
- Create: `relay/src/onion.test.ts`

---

### Step 1: Write the failing crypto tests

Create `relay/src/crypto.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { seedToX25519Priv, peelLayer } from './onion';
import { hexToBytes, bytesToHex } from './crypto';

describe('seedToX25519Priv', () => {
  it('matches expected RFC 7748 clamp pattern', () => {
    const seed = new Uint8Array(32).fill(0x42);
    const priv = seedToX25519Priv(seed);
    expect(priv.length).toBe(32);
    // Low 3 bits of first byte must be 0
    expect(priv[0] & 0b111).toBe(0);
    // Top bit of last byte must be 0
    expect(priv[31] & 0x80).toBe(0);
    // Bit 6 of last byte must be 1
    expect(priv[31] & 0x40).toBe(0x40);
  });
});

describe('hexToBytes / bytesToHex round-trip', () => {
  it('round-trips', () => {
    const hex = 'deadbeef01020304';
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });
});
```

Run to verify it fails (module doesn't exist yet):

```bash
cd relay
npx vitest run src/crypto.test.ts 2>&1 | head -20
```

Expected: `Error: Cannot find module './onion'`

---

### Step 2: Write the failing onion peel tests

Create `relay/src/onion.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildTestPacket, peelLayer } from './onion';

describe('peelLayer', () => {
  it('decrypts a Forward payload', async () => {
    const { packet, seedHex, expectedNextUrl, expectedInner } =
      await buildTestPacket('forward');
    const result = peelLayer(packet, seedHex);
    expect(result.type).toBe('forward');
    if (result.type !== 'forward') throw new Error();
    expect(result.nextHopUrl).toBe(expectedNextUrl);
    expect(result.innerPacket).toEqual(expectedInner);
  });

  it('decrypts a Deliver payload', async () => {
    const { packet, seedHex, expectedNodeId, expectedMessage } =
      await buildTestPacket('deliver');
    const result = peelLayer(packet, seedHex);
    expect(result.type).toBe('deliver');
    if (result.type !== 'deliver') throw new Error();
    expect(result.destinationNodeId).toEqual(expectedNodeId);
    expect(result.message).toEqual(expectedMessage);
  });

  it('throws on wrong seed', async () => {
    const { packet } = await buildTestPacket('forward');
    const wrongSeed = new Uint8Array(32).fill(0xff);
    expect(() => peelLayer(packet, bytesToHex(wrongSeed))).toThrow();
  });

  it('throws on tampered envelope', async () => {
    const { packet, seedHex } = await buildTestPacket('forward');
    packet[packet.length - 1] ^= 0xff;
    expect(() => peelLayer(packet, seedHex)).toThrow();
  });

  it('throws on too-short envelope', () => {
    expect(() => peelLayer(new Uint8Array(10), 'a'.repeat(64))).toThrow();
  });
});
```

Note: `buildTestPacket` is a test helper you'll add to `onion.ts` behind `if (process.env.NODE_ENV === 'test')`. It uses the Rust-compatible crypto to generate a test packet.

Run to verify they fail:

```bash
cd relay
npx vitest run src/onion.test.ts 2>&1 | head -20
```

Expected: module not found.

---

### Step 3: Scaffold the package

Create `relay/package.json`:

```json
{
  "name": "@delta/relay-worker",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@noble/ciphers": "^1.0.0",
    "@noble/curves": "^1.6.0",
    "@noble/hashes": "^1.5.0",
    "pkarr": "^2.2.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241218.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

Create `relay/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

Create `relay/wrangler.toml`:

```toml
name = "delta-relay"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[triggers]
crons = ["0 * * * *"]   # publish pkarr record every hour

# Secrets (set via `wrangler secret put`):
#   RELAY_SEED_HEX   — 64 hex chars, Ed25519 seed for this relay's keypair
#   IROH_BRIDGE_URL  — URL of the iroh delivery bridge (see Task 4)
```

Install dependencies:

```bash
cd relay
npm install
```

---

### Step 4: Implement `relay/src/crypto.ts`

```typescript
/**
 * Shared byte-level utilities.
 */

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
```

---

### Step 5: Implement `relay/src/onion.ts`

```typescript
/**
 * Onion layer peeling — TypeScript port of core/src/onion.rs.
 *
 * Wire format: VERSION[1] | EPK[32] | NONCE[24] | CIPHERTEXT[N]
 * Min valid length: 1 + 32 + 24 + 16 (Poly1305 tag) = 73 bytes
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { edwardsToMontgomeryPriv, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from './crypto';

const VERSION = 0x02;
const HKDF_INFO = new TextEncoder().encode('delta:onion:v1');
const MIN_LEN = 1 + 32 + 24 + 16;

// ── Key conversion ────────────────────────────────────────────────────────────

/**
 * Convert a 32-byte Ed25519 seed to an X25519 private key.
 * Matches core/src/crypto.rs `ed25519_seed_to_x25519`.
 */
export function seedToX25519Priv(seed: Uint8Array): Uint8Array {
  const hash = sha512(seed);
  const key = hash.slice(0, 32);
  key[0] &= 248;
  key[31] &= 127;
  key[31] |= 64;
  return key;
}

// ── Payload decoding ──────────────────────────────────────────────────────────

export type OnionPayload =
  | { type: 'forward'; nextHopUrl: string; innerPacket: Uint8Array }
  | { type: 'deliver'; destinationNodeId: Uint8Array; message: Uint8Array };

function decodePayload(bytes: Uint8Array): OnionPayload {
  if (bytes.length === 0) throw new Error('empty payload');
  const type = bytes[0];

  if (type === 0x01) {
    if (bytes.length < 3) throw new Error('Forward payload too short');
    const urlLen = (bytes[1] << 8) | bytes[2];
    if (bytes.length < 3 + urlLen) throw new Error('Forward URL truncated');
    const url = new TextDecoder().decode(bytes.slice(3, 3 + urlLen));
    const innerPacket = bytes.slice(3 + urlLen);
    return { type: 'forward', nextHopUrl: url, innerPacket };
  }

  if (type === 0x02) {
    if (bytes.length < 1 + 32) throw new Error('Deliver payload too short');
    const destinationNodeId = bytes.slice(1, 33);
    const message = bytes.slice(33);
    return { type: 'deliver', destinationNodeId, message };
  }

  throw new Error(`unknown payload type 0x${type.toString(16)}`);
}

// ── Layer peeling ─────────────────────────────────────────────────────────────

/**
 * Peel one onion layer.
 *
 * @param envelope        Raw onion packet bytes.
 * @param recipientSeedHex 64 hex chars — Ed25519 seed of this hop's keypair.
 */
export function peelLayer(envelope: Uint8Array, recipientSeedHex: string): OnionPayload {
  if (envelope.length < MIN_LEN) throw new Error('envelope too short');
  if (envelope[0] !== VERSION) throw new Error(`unsupported version 0x${envelope[0].toString(16)}`);

  const epk = envelope.slice(1, 33);
  const nonce = envelope.slice(33, 57);
  const ciphertext = envelope.slice(57);

  const seed = hexToBytes(recipientSeedHex);
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');

  const x25519Priv = seedToX25519Priv(seed);
  const shared = x25519.getSharedSecret(x25519Priv, epk);

  // HKDF-SHA256(ikm=shared, salt=epk, info="delta:onion:v1") → 32-byte key
  const aesKey = hkdf(sha256, shared, epk, HKDF_INFO, 32);

  const plaintext = xchacha20poly1305(aesKey, nonce).decrypt(ciphertext);
  return decodePayload(plaintext);
}

// ── Test helpers (only used in unit tests) ────────────────────────────────────

/** Build an encrypted test packet using @noble crypto — mirrors Rust encrypt_layer. */
export async function buildTestPacket(kind: 'forward' | 'deliver'): Promise<{
  packet: Uint8Array;
  seedHex: string;
  expectedNextUrl?: string;
  expectedInner?: Uint8Array;
  expectedNodeId?: Uint8Array;
  expectedMessage?: Uint8Array;
}> {
  const { ed25519 } = await import('@noble/curves/ed25519');
  const { randomBytes } = await import('@noble/hashes/utils');
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha');

  const seed = randomBytes(32);
  const seedHex = bytesToHex(seed);
  const privKey = seedToX25519Priv(seed);
  const pubKey = x25519.getPublicKey(privKey);
  // Note: pubKey here is the X25519 key; in the real protocol the sender uses
  // ed25519_pubkey_to_x25519. For the test we use the X25519 pubkey directly
  // since edwardsToMontgomeryPub(ed25519.getPublicKey(seed)) == x25519.getPublicKey(seedToX25519Priv(seed)).

  const ephemeralPriv = randomBytes(32);
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const shared = x25519.getSharedSecret(ephemeralPriv, pubKey);
  const aesKey = hkdf(sha256, shared, ephemeralPub, HKDF_INFO, 32);
  const nonce = randomBytes(24);

  let plaintext: Uint8Array;
  let extras: object;
  if (kind === 'forward') {
    const url = 'https://hop2.example.com/hop';
    const inner = new Uint8Array([1, 2, 3, 4]);
    const urlBytes = new TextEncoder().encode(url);
    plaintext = new Uint8Array(3 + urlBytes.length + inner.length);
    plaintext[0] = 0x01;
    plaintext[1] = (urlBytes.length >> 8) & 0xff;
    plaintext[2] = urlBytes.length & 0xff;
    plaintext.set(urlBytes, 3);
    plaintext.set(inner, 3 + urlBytes.length);
    extras = { expectedNextUrl: url, expectedInner: inner };
  } else {
    const nodeId = randomBytes(32);
    const message = new TextEncoder().encode('hello delta');
    plaintext = new Uint8Array(1 + 32 + message.length);
    plaintext[0] = 0x02;
    plaintext.set(nodeId, 1);
    plaintext.set(message, 33);
    extras = { expectedNodeId: nodeId, expectedMessage: message };
  }

  const ciphertext = xchacha20poly1305(aesKey, nonce).encrypt(plaintext);
  const packet = new Uint8Array(1 + 32 + 24 + ciphertext.length);
  packet[0] = VERSION;
  packet.set(ephemeralPub, 1);
  packet.set(nonce, 33);
  packet.set(ciphertext, 57);

  return { packet, seedHex, ...extras } as any;
}
```

---

### Step 6: Run the crypto + onion tests — verify they pass

```bash
cd relay
npm install
npx vitest run 2>&1
```

Expected: all 7 tests in `crypto.test.ts` + `onion.test.ts` pass.

---

### Step 7: Implement `relay/src/index.ts`

```typescript
/**
 * Delta Relay — Cloudflare Worker.
 *
 * Endpoints:
 *   POST /hop   — receive an onion packet, peel one layer, route it
 *   GET  /pubkey — return this relay's Ed25519 pubkey hex (for discovery)
 *
 * Secrets (set via `wrangler secret put`):
 *   RELAY_SEED_HEX   64 hex char Ed25519 seed
 *   IROH_BRIDGE_URL  URL of the iroh delivery bridge
 */

import { edwardsToMontgomeryPub, ed25519 } from '@noble/curves/ed25519';
import { peelLayer } from './onion';
import { hexToBytes, bytesToHex } from './crypto';
import { publishRelaySelf } from './pkarr';

export interface Env {
  RELAY_SEED_HEX: string;
  IROH_BRIDGE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── GET /pubkey — return Ed25519 pubkey for discovery ──────────────────────
    if (request.method === 'GET' && url.pathname === '/pubkey') {
      const seed = hexToBytes(env.RELAY_SEED_HEX);
      const pubkey = ed25519.getPublicKey(seed);
      return new Response(bytesToHex(pubkey), {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // ── POST /hop — peel one onion layer ──────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/hop') {
      const body = await request.arrayBuffer();
      const packet = new Uint8Array(body);

      let payload;
      try {
        payload = peelLayer(packet, env.RELAY_SEED_HEX);
      } catch (err) {
        return new Response('bad packet', { status: 400 });
      }

      if (payload.type === 'forward') {
        // Forward the inner packet to the next hop.
        const resp = await fetch(payload.nextHopUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload.innerPacket,
        });
        return new Response(null, { status: resp.ok ? 200 : 502 });
      }

      if (payload.type === 'deliver') {
        // Hand off to the iroh delivery bridge.
        const resp = await fetch(env.IROH_BRIDGE_URL + '/deliver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_id: bytesToHex(payload.destinationNodeId),
            message_base64: btoa(
              String.fromCharCode(...payload.message),
            ),
          }),
        });
        return new Response(null, { status: resp.ok ? 200 : 502 });
      }

      return new Response('unknown payload type', { status: 400 });
    }

    return new Response('not found', { status: 404 });
  },

  // Cron trigger: publish pkarr record every hour.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await publishRelaySelf(env.RELAY_SEED_HEX, new URL('https://placeholder.workers.dev').href);
  },
} satisfies ExportedHandler<Env>;
```

### Step 8: Run TypeScript type-check

```bash
cd relay
npx tsc --noEmit 2>&1
```

Expected: no errors.

### Step 9: Commit

```bash
cd relay  # from repo root: git -C .. add relay/
git -C .. add relay/
git -C .. commit -m "feat(relay): Cloudflare Worker relay with onion peel + forward/deliver routing"
```

---

## Task 3: Relay pkarr Self-Publishing

The Worker needs to publish its Ed25519 public key to the pkarr DHT so the app can discover it. This involves two sub-tasks: (A) the Worker-side pkarr publisher in TypeScript, and (B) adding relay record parsing to the Rust core so the app can interpret the resolved record.

---

### Sub-task 3A: Worker-side pkarr publisher

**Files:**
- Create: `relay/src/pkarr.ts`

#### Step 1: Write the test

Add `relay/src/pkarr.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildRelayTxtRecord, parseRelayTxtRecord } from './pkarr';

describe('buildRelayTxtRecord', () => {
  it('produces the correct format', () => {
    const record = buildRelayTxtRecord(
      'aabbcc00'.repeat(8),         // 64-char pubkey hex
      'https://relay.delta.app/hop',
    );
    expect(record).toBe(
      'v=delta1;t=relay;n=https://relay.delta.app/hop;a=aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00',
    );
  });
});

describe('parseRelayTxtRecord', () => {
  it('round-trips', () => {
    const pubkeyHex = 'aabbcc00'.repeat(8);
    const hopUrl    = 'https://relay.delta.app/hop';
    const record    = buildRelayTxtRecord(pubkeyHex, hopUrl);
    const parsed    = parseRelayTxtRecord(record);
    expect(parsed).toEqual({ pubkeyHex, hopUrl });
  });

  it('returns null for non-relay records', () => {
    expect(parseRelayTxtRecord('v=delta1;t=user;u=alice')).toBeNull();
  });
});
```

Run to verify fail:

```bash
cd relay && npx vitest run src/pkarr.test.ts 2>&1 | head -20
```

Expected: cannot find module `./pkarr`.

#### Step 2: Implement `relay/src/pkarr.ts`

```typescript
/**
 * pkarr DHT publishing for the relay worker.
 *
 * The relay signs a DNS TXT record with its Ed25519 keypair and publishes
 * it to the mainline BitTorrent DHT via the pkarr npm package.
 *
 * TXT record format: v=delta1;t=relay;n=<hop_url>;a=<ed25519_pubkey_hex>
 */

import { Pkarr, SignedPacket, Keypair } from 'pkarr';
import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes, bytesToHex } from './crypto';

// ── Record builders ───────────────────────────────────────────────────────────

export function buildRelayTxtRecord(pubkeyHex: string, hopUrl: string): string {
  return `v=delta1;t=relay;n=${hopUrl};a=${pubkeyHex}`;
}

export function parseRelayTxtRecord(
  txt: string,
): { pubkeyHex: string; hopUrl: string } | null {
  if (!txt.startsWith('v=delta1')) return null;
  const fields: Record<string, string> = {};
  for (const part of txt.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  if (fields['t'] !== 'relay') return null;
  const pubkeyHex = fields['a'];
  const hopUrl    = fields['n'];
  if (!pubkeyHex || !hopUrl) return null;
  return { pubkeyHex, hopUrl };
}

// ── DHT publishing ────────────────────────────────────────────────────────────

/**
 * Publish this relay's pubkey + hop URL to the pkarr DHT.
 * Called from the Cloudflare cron trigger every hour.
 *
 * @param seedHex   64 hex chars — Ed25519 seed
 * @param selfUrl   Public URL of this Worker (e.g. https://relay.delta.app)
 */
export async function publishRelaySelf(seedHex: string, selfUrl: string): Promise<void> {
  const seed    = hexToBytes(seedHex);
  const pubkey  = ed25519.getPublicKey(seed);
  const hopUrl  = selfUrl.replace(/\/$/, '') + '/hop';
  const txt     = buildRelayTxtRecord(bytesToHex(pubkey), hopUrl);

  const keypair = Keypair.fromSecretKey(seed);
  const packet  = await SignedPacket.fromKeypair(keypair, (builder) => {
    builder.txt('_delta-relay', txt, 7200);
  });

  const client = new Pkarr();
  await client.publish(packet);

  console.log(`[pkarr] published relay record for ${keypair.publicKey().z32()}`);
}
```

#### Step 3: Run tests — verify they pass

```bash
cd relay && npx vitest run 2>&1
```

Expected: all tests pass (original + 3 new pkarr tests).

#### Step 4: Update `index.ts` cron trigger with correct `selfUrl`

Edit the `scheduled` handler in `relay/src/index.ts` — replace the placeholder URL:

```typescript
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // SELF_URL secret: the public URL of this deployed Worker
    // Set via: wrangler secret put SELF_URL
    const selfUrl = (env as any).SELF_URL ?? 'https://delta-relay.workers.dev';
    await publishRelaySelf(env.RELAY_SEED_HEX, selfUrl);
  },
```

Also add `SELF_URL` to `wrangler.toml` comment block:

```toml
#   SELF_URL         Public URL of this Worker (e.g. https://relay.delta.app)
```

---

### Sub-task 3B: Relay record parsing in the Rust core

The app calls `resolvePkarr(z32Key)` → gets back `PkarrResolved`. For relay nodes, `record_type = "relay"`, `name = hop_url`, `avatarBlobId = ed25519_pubkey_hex`. This needs one change in `pkarr_publish.rs`.

**Files:**
- Modify: `core/src/pkarr_publish.rs`

#### Step 1: Write the failing test

Add to `core/src/pkarr_publish.rs` inside the `#[cfg(test)] mod tests` block (create it if absent):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_relay_record() {
        let txt = "v=delta1;t=relay;n=https://relay.delta.app/hop;a=aabbccdd".repeat(1)
            .replace("aabbccdd", &"ab".repeat(32));
        // txt = "v=delta1;t=relay;n=https://relay.delta.app/hop;a=abab...ab"
        let txt = format!("v=delta1;t=relay;n=https://relay.delta.app/hop;a={}", "ab".repeat(32));
        let record = parse_txt_record(&txt, "testz32key").unwrap();
        assert_eq!(record.record_type, "relay");
        assert_eq!(record.name.as_deref(), Some("https://relay.delta.app/hop"));
        assert_eq!(record.avatar_blob_id.as_deref(), Some(&"ab".repeat(32) as &str));
    }

    #[test]
    fn parse_user_record_still_works() {
        let txt = "v=delta1;t=user;u=alice;b=hello";
        let record = parse_txt_record(txt, "testz32key").unwrap();
        assert_eq!(record.record_type, "user");
        assert_eq!(record.username.as_deref(), Some("alice"));
        assert_eq!(record.bio.as_deref(), Some("hello"));
    }
}
```

Run to verify current behaviour:

```bash
cd core && cargo test pkarr -- --nocapture
```

Expected: the `parse_relay_record` test fails (`record_type` is `"none"` because `t=relay` isn't handled), `parse_user_record_still_works` passes.

#### Step 2: Add `relay` case to `parse_txt_record`

In `core/src/pkarr_publish.rs`, find the `parse_txt_record` function. In the `match key { ... }` block, `"t"` is already handled but only sets `record_type`. The `"n"` key maps to `name` and `"a"` to `avatar_blob_id` — these already exist. The only change needed is ensuring `t=relay` ends up in `record_type`.

Look at the existing code — `"t" => record.record_type = value.to_string()` already handles all values including `"relay"`. The fields `n` and `a` are already parsed. So the test should actually pass with zero code changes.

Run the test again:

```bash
cd core && cargo test pkarr -- --nocapture
```

Expected: both tests pass. If they do, no code change is needed — the record format already works.

#### Step 3: Commit

```bash
cd core
git add src/pkarr_publish.rs
git commit -m "test(pkarr): verify relay record type parsing"
```

---

## Task 4: App Relay Discovery and Route Selection

**Files:**
- Create: `app/src/stores/useRelayStore.ts`
- Create: `app/src/utils/onionRoute.ts`

---

### Step 1: Write the tests

Create `app/__tests__/onionRoute.test.ts`:

```typescript
/**
 * Unit tests for onionRoute utilities.
 * These run against the JS stubs (no native module needed).
 */

import { parseRelayRecord, hopFromRecord } from '../src/utils/onionRoute';

describe('parseRelayRecord', () => {
  it('extracts hop URL and pubkey from a relay PkarrResolved', () => {
    const record = {
      recordType: 'relay',
      name: 'https://relay.delta.app/hop',
      avatarBlobId: 'ab'.repeat(32),
      username: null,
      description: null,
      bio: null,
      coverBlobId: null,
      publicKey: 'somez32key',
    };
    const hop = parseRelayRecord(record);
    expect(hop).toEqual({
      pubkeyHex: 'ab'.repeat(32),
      nextUrl: 'https://relay.delta.app/hop',
    });
  });

  it('returns null for non-relay records', () => {
    const record = {
      recordType: 'user',
      name: null,
      avatarBlobId: null,
      username: 'alice',
      description: null,
      bio: null,
      coverBlobId: null,
      publicKey: 'somez32key',
    };
    expect(parseRelayRecord(record)).toBeNull();
  });

  it('returns null when name or avatarBlobId is missing', () => {
    const record = {
      recordType: 'relay',
      name: null,
      avatarBlobId: null,
      username: null,
      description: null,
      bio: null,
      coverBlobId: null,
      publicKey: 'key',
    };
    expect(parseRelayRecord(record)).toBeNull();
  });
});
```

Run to verify fail:

```bash
cd app && npx jest __tests__/onionRoute.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '../src/utils/onionRoute'`.

---

### Step 2: Implement `app/src/utils/onionRoute.ts`

```typescript
/**
 * Onion route utilities: resolve relay hops from pkarr and send messages.
 */

import { resolvePkarr, buildOnionPacket, type PkarrResolved, type OnionHopFfi } from '../ffi/deltaCore';

/**
 * Parse a PkarrResolved record as a relay hop descriptor.
 * Relay records use: record_type="relay", name=<hop_url>, avatarBlobId=<pubkey_hex>
 */
export function parseRelayRecord(record: PkarrResolved): OnionHopFfi | null {
  if (record.recordType !== 'relay') return null;
  if (!record.name || !record.avatarBlobId) return null;
  return {
    pubkeyHex: record.avatarBlobId,
    nextUrl: record.name,
  };
}

/**
 * Resolve a list of relay pkarr z32 keys into ordered hop descriptors.
 * Keys that fail to resolve or are not relay records are silently skipped.
 */
export async function resolveRelayHops(z32Keys: string[]): Promise<OnionHopFfi[]> {
  const hops: OnionHopFfi[] = [];
  for (const key of z32Keys) {
    try {
      const record = await resolvePkarr(key);
      if (!record) continue;
      const hop = parseRelayRecord(record);
      if (hop) hops.push(hop);
    } catch {
      // Individual resolution failures are non-fatal
    }
  }
  return hops;
}

/**
 * Build and send an onion-routed message to a destination iroh node.
 *
 * @param hops            Ordered list of relay hop descriptors (first hop is the entry).
 * @param destNodeIdHex   64 hex chars — iroh node ID of the final recipient.
 * @param messageBytes    Raw delta protocol message bytes.
 */
export async function sendOnionMessage(
  hops: OnionHopFfi[],
  destNodeIdHex: string,
  messageBytes: Uint8Array,
): Promise<void> {
  if (hops.length === 0) throw new Error('need at least one relay hop');

  const destNodeId = hexToBytes(destNodeIdHex);
  const packet = await buildOnionPacket(hops, destNodeId, messageBytes);

  const resp = await fetch(hops[0].nextUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: packet,
  });

  if (!resp.ok) throw new Error(`relay returned ${resp.status}`);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
```

---

### Step 3: Run the tests — verify they pass

```bash
cd app && npx jest __tests__/onionRoute.test.ts 2>&1
```

Expected: 4 tests pass.

---

### Step 4: Implement `app/src/stores/useRelayStore.ts`

```typescript
/**
 * Relay store — maintains the ordered list of known relay hops.
 *
 * Usage:
 *   const { hops, refresh } = useRelayStore();
 *   // hops is ready once refresh() resolves
 *   await sendOnionMessage(hops, destNodeId, bytes);
 */

import { create } from 'zustand';
import { resolveRelayHops, type OnionHopFfi } from '../utils/onionRoute';

/**
 * Hardcoded list of relay pkarr z32 keys for the Delta-operated relays.
 * Update this list when new relay Workers are deployed.
 * Format: z32-encoded Ed25519 public key (the pkarr address of the relay).
 */
export const KNOWN_RELAY_PKARR_KEYS: string[] = [
  // Add relay z32 keys here once Workers are deployed, e.g.:
  // 'yj4bqhvahk8dge4pbzxxxx...'
];

interface RelayState {
  hops: OnionHopFfi[];
  loading: boolean;
  /** Re-resolve all KNOWN_RELAY_PKARR_KEYS from the DHT. */
  refresh(): Promise<void>;
}

export const useRelayStore = create<RelayState>((set) => ({
  hops: [],
  loading: false,

  async refresh() {
    set({ loading: true });
    try {
      const hops = await resolveRelayHops(KNOWN_RELAY_PKARR_KEYS);
      set({ hops });
    } finally {
      set({ loading: false });
    }
  },
}));
```

---

### Step 5: Verify TypeScript compiles

```bash
cd app && npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -20
```

Expected: no errors referencing `onionRoute.ts` or `useRelayStore.ts`.

---

### Step 6: Commit

```bash
cd app
git add src/utils/onionRoute.ts src/stores/useRelayStore.ts __tests__/onionRoute.test.ts
git commit -m "feat(relay): app route selection — resolveRelayHops + sendOnionMessage + useRelayStore"
```

---

## Quick Reference

| Component | File | Purpose |
|---|---|---|
| Android bridge | `app/android/…/DeltaCoreModule.kt` | Exposes `buildOnionPacket` / `peelOnionLayer` to RN |
| Worker entry | `relay/src/index.ts` | `POST /hop` + cron publisher |
| Worker crypto | `relay/src/onion.ts` | TypeScript port of `core/src/onion.rs` |
| Worker pkarr | `relay/src/pkarr.ts` | Publish relay record to DHT |
| App utility | `app/src/utils/onionRoute.ts` | Resolve hops, build packet, send |
| App store | `app/src/stores/useRelayStore.ts` | Cached relay hops for UI use |

## What Comes Next (Out of Scope)

- **Iroh relay HTTP bridge** — A persistent server (likely Rust) with `POST /deliver` that injects `{ node_id, message }` into the iroh QUIC network. The Worker already calls `IROH_BRIDGE_URL/deliver`; this endpoint needs a real implementation.
- **Deploy relay Worker** — `wrangler secret put RELAY_SEED_HEX` + `wrangler deploy`, then add the resulting z32 key to `KNOWN_RELAY_PKARR_KEYS` in `useRelayStore.ts`.
- **Multi-hop route selection** — Currently the app uses all known relays as hops in order. A future improvement picks a random subset of N hops for better anonymity.

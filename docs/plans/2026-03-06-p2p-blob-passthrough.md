# P2P Blob Passthrough Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow public profile avatars (user + org) to be served through the web gateway by proxying blob requests to the owner's relay, where blobs are stored on PUT when a profile is published.

**Architecture:** The relay gains `PUT /public-blob/:blobId` (stores small blobs in KV, verifies content hash) and `GET /public-blob/:blobId` (serves them). User/org pkarr TXT records gain an `rl=<relay-z32>` field so the web gateway can discover which relay to fetch from. The gateway's `/blob/:blobId?owner=<z32>` route does a two-hop pkarr resolution (user → relay) then proxies the blob, verifying the sha256 matches before serving. The app uploads the avatar blob to the relay at profile-publish time.

**Tech Stack:** Cloudflare Workers (relay + web gateway), Cloudflare KV (blob storage on relay), TypeScript (relay/web), Rust (core pkarr_publish), React Native (app layer blob upload), `@noble/hashes` (sha256 verification)

---

## Context for the implementer

Key file locations:
- Relay worker: `relay/src/index.ts`, `relay/wrangler.toml`
- Web gateway: `web/src/index.ts`, `web/src/pkarr.ts`, `web/src/template.ts`, `web/wrangler.toml`
- Rust pkarr publishing: `core/src/pkarr_publish.rs`
- App profile store: `app/src/stores/useProfileStore.ts`
- App org store: `app/src/stores/useOrgsStore.ts`
- App FFI: `app/src/ffi/gardensCore.ts`

The relay already has `@noble/hashes` available via `@noble/curves` (same package family). If not, install `@noble/hashes`.

Blob IDs are hex-encoded SHA-256 hashes of content (64 hex chars). This is the key security invariant: `sha256(blobBytes) === blobId`.

The relay's pkarr TXT record format is: `v=gardens1;t=relay;n=<hop_url>;a=<pubkey_hex>`
The hop URL is `{selfUrl}/hop`. Strip `/hop` to get the base relay URL.

---

## Task 1: Relay — Create KV namespace for public blob storage

**Files:**
- Modify: `relay/wrangler.toml`

**Step 1: Create the KV namespace**

```bash
cd relay && npx wrangler kv namespace create PUBLIC_BLOBS
```

Expected output includes something like:
```
{ binding = "PUBLIC_BLOBS", id = "abc123..." }
```

**Step 2: Add the binding to wrangler.toml**

Add after the `[triggers]` section:

```toml
[[kv_namespaces]]
binding = "PUBLIC_BLOBS"
id = "<paste-id-from-step-1>"
```

**Step 3: Add preview ID for local dev (optional but useful)**

```toml
[[kv_namespaces]]
binding = "PUBLIC_BLOBS"
id = "<production-id>"
preview_id = "<paste-preview-id-from-step-1>"
```

**Step 4: Verify wrangler dev still starts**

```bash
cd relay && npm run dev
```

Expected: worker starts on localhost:8787 with no errors.

**Step 5: Commit**

```bash
git add relay/wrangler.toml
git commit -m "feat(relay): add PUBLIC_BLOBS KV namespace for public avatar storage"
```

---

## Task 2: Relay — Add PUT /public-blob/:blobId endpoint

**Files:**
- Modify: `relay/src/index.ts`

**Step 1: Write the failing test**

Create `relay/src/blob.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Inline the logic we're about to write so we can unit-test it
// without a full Worker env
import { sha256 } from '@noble/hashes/sha256';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('blob hash verification', () => {
  it('accepts a blob whose hash matches the blobId', () => {
    const content = new TextEncoder().encode('hello world');
    const hash = bytesToHex(sha256(content));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Simulate verification
    const computedHash = bytesToHex(sha256(content));
    expect(computedHash).toBe(hash);
  });

  it('rejects a blob whose hash does not match', () => {
    const content = new TextEncoder().encode('hello world');
    const wrongId = 'a'.repeat(64);
    const computedHash = bytesToHex(sha256(content));
    expect(computedHash).not.toBe(wrongId);
  });
});

describe('blob size validation', () => {
  it('rejects blobs over 2MB', () => {
    const MAX = 2 * 1024 * 1024;
    const overSize = MAX + 1;
    expect(overSize > MAX).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd relay && npm test -- blob.test.ts
```

Expected: fails with `Cannot find module '@noble/hashes/sha256'` or similar if not installed.

**Step 3: Install @noble/hashes if needed**

Check if already present:
```bash
cd relay && cat package.json | grep noble
```

If `@noble/hashes` is not listed, install it:
```bash
cd relay && npm install @noble/hashes
```

Re-run test — should now PASS.

**Step 4: Add the PUT handler to relay/src/index.ts**

Add `KVNamespace` to the `Env` interface:

```typescript
export interface Env {
  RELAY_SEED_HEX: string;
  SELF_URL?: string;
  SYNC: Fetcher;
  PUBLIC_BLOBS: KVNamespace;
}
```

Add a helper at the top of the file (after imports):

```typescript
import { sha256 } from '@noble/hashes/sha256';

const MAX_BLOB_BYTES = 2 * 1024 * 1024; // 2 MB

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

Add the PUT handler inside the `fetch` function, before the final `return new Response('not found', { status: 404 })`:

```typescript
// ── PUT /public-blob/:blobId — store a content-addressed public blob ────────
if (request.method === 'PUT' && url.pathname.startsWith('/public-blob/')) {
  const blobId = url.pathname.slice('/public-blob/'.length);

  // Validate blobId format (64 hex chars = SHA-256)
  if (!/^[0-9a-f]{64}$/i.test(blobId)) {
    return new Response('invalid blob id', { status: 400 });
  }

  const contentLength = parseInt(request.headers.get('Content-Length') ?? '0', 10);
  if (contentLength > MAX_BLOB_BYTES) {
    return new Response('blob too large (max 2MB)', { status: 413 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());

  if (bytes.length > MAX_BLOB_BYTES) {
    return new Response('blob too large (max 2MB)', { status: 413 });
  }

  // Content-address verification: sha256(body) must equal blobId
  const computedHash = toHex(sha256(bytes));
  if (computedHash !== blobId.toLowerCase()) {
    return new Response('hash mismatch', { status: 400 });
  }

  const mimeType = request.headers.get('Content-Type') ?? 'application/octet-stream';

  await env.PUBLIC_BLOBS.put(blobId, bytes, {
    metadata: { mimeType },
    expirationTtl: 60 * 60 * 24 * 90, // 90 days
  });

  return new Response(null, { status: 204 });
}
```

**Step 5: Verify the test still passes**

```bash
cd relay && npm test -- blob.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add relay/src/index.ts relay/src/blob.test.ts relay/package.json relay/package-lock.json
git commit -m "feat(relay): add PUT /public-blob/:blobId with sha256 verification"
```

---

## Task 3: Relay — Add GET /public-blob/:blobId endpoint

**Files:**
- Modify: `relay/src/index.ts`

**Step 1: Write the test**

Add to `relay/src/blob.test.ts`:

```typescript
describe('GET /public-blob response headers', () => {
  it('sets immutable cache-control for content-addressed blobs', () => {
    const cacheControl = 'public, max-age=31536000, immutable';
    expect(cacheControl).toContain('immutable');
  });
});
```

**Step 2: Run to verify it passes immediately (it's a pure value check)**

```bash
cd relay && npm test -- blob.test.ts
```

Expected: PASS.

**Step 3: Add the GET handler**

Add inside `fetch`, directly after the PUT handler you added in Task 2:

```typescript
// ── GET /public-blob/:blobId — serve a stored public blob ──────────────────
if (request.method === 'GET' && url.pathname.startsWith('/public-blob/')) {
  const blobId = url.pathname.slice('/public-blob/'.length);

  if (!/^[0-9a-f]{64}$/i.test(blobId)) {
    return new Response('invalid blob id', { status: 400 });
  }

  const { value, metadata } = await env.PUBLIC_BLOBS.getWithMetadata<{ mimeType: string }>(
    blobId,
    'arrayBuffer',
  );

  if (!value) {
    return new Response('not found', { status: 404 });
  }

  return new Response(value, {
    headers: {
      'Content-Type': metadata?.mimeType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
```

**Step 4: Quick smoke test via wrangler dev**

```bash
cd relay && npm run dev
# In another terminal:
echo -n "hello" | curl -X PUT http://localhost:8787/public-blob/$(echo -n "hello" | sha256sum | cut -d' ' -f1) \
  -H "Content-Type: text/plain" --data-binary @-
curl http://localhost:8787/public-blob/$(echo -n "hello" | sha256sum | cut -d' ' -f1)
```

Expected: PUT returns 204, GET returns `hello`.

**Step 5: Commit**

```bash
git add relay/src/index.ts relay/src/blob.test.ts
git commit -m "feat(relay): add GET /public-blob/:blobId endpoint"
```

---

## Task 4: Rust core — Add relay z32 field to pkarr TXT records

**Files:**
- Modify: `core/src/pkarr_publish.rs`

The `rl=` field carries the z32-encoded public key of the user's relay. The web gateway will use this to find which relay to fetch avatars from.

**Step 1: Update build_user_txt_record to accept relay_z32**

In `core/src/pkarr_publish.rs`, change the signature:

```rust
fn build_user_txt_record(
    username: &str,
    bio: Option<&str>,
    avatar_blob_id: Option<&str>,
    relay_z32: Option<&str>,
) -> String {
    let mut parts = vec![
        "v=gardens1".to_string(),
        "t=user".to_string(),
        format!("u={}", username),
    ];

    if let Some(bio_str) = bio {
        if !bio_str.is_empty() {
            let truncated = if bio_str.len() > 100 {
                format!("{}...", &bio_str[..97])
            } else {
                bio_str.to_string()
            };
            parts.push(format!("b={}", truncated));
        }
    }

    if let Some(avatar) = avatar_blob_id {
        parts.push(format!("a={}", avatar));
    }

    if let Some(relay) = relay_z32 {
        parts.push(format!("rl={}", relay));
    }

    parts.join(";")
}
```

**Step 2: Update build_org_txt_record similarly**

```rust
fn build_org_txt_record(
    name: &str,
    description: Option<&str>,
    avatar_blob_id: Option<&str>,
    cover_blob_id: Option<&str>,
    relay_z32: Option<&str>,
) -> String {
    let mut parts = vec![
        "v=gardens1".to_string(),
        "t=org".to_string(),
        format!("n={}", name),
    ];

    if let Some(desc) = description {
        if !desc.is_empty() {
            let truncated = if desc.len() > 150 {
                format!("{}...", &desc[..147])
            } else {
                desc.to_string()
            };
            parts.push(format!("d={}", truncated));
        }
    }

    if let Some(avatar) = avatar_blob_id {
        parts.push(format!("a={}", avatar));
    }

    if let Some(cover) = cover_blob_id {
        parts.push(format!("c={}", cover));
    }

    if let Some(relay) = relay_z32 {
        parts.push(format!("rl={}", relay));
    }

    parts.join(";")
}
```

**Step 3: Update publish_profile signature**

```rust
pub async fn publish_profile(
    private_key_hex: &str,
    username: &str,
    bio: Option<&str>,
    avatar_blob_id: Option<&str>,
    relay_z32: Option<&str>,
) -> Result<(), String> {
    // ...existing keypair setup...
    let txt_value = build_user_txt_record(username, bio, avatar_blob_id, relay_z32);
    // ...rest unchanged...
}
```

**Step 4: Update publish_org_with_key signature**

```rust
pub async fn publish_org_with_key(
    private_key_hex: &str,
    org_id: &str,
    name: &str,
    description: Option<&str>,
    avatar_blob_id: Option<&str>,
    cover_blob_id: Option<&str>,
    relay_z32: Option<&str>,
) -> Result<(), String> {
    // ...existing keypair setup...
    let txt_value = build_org_txt_record(name, description, avatar_blob_id, cover_blob_id, relay_z32);
    // ...rest unchanged...
}
```

**Step 5: Fix all call sites in lib.rs and pkarr_publish.rs**

Search for all calls to `publish_profile` and `publish_org_with_key` and add `None` as the last argument (relay_z32 not yet wired up — that's Task 5):

```bash
cd core && grep -n "publish_profile\|publish_org_with_key" src/lib.rs src/pkarr_publish.rs
```

For each call site, append `, None` before the closing `)`.

Also update `republish_all` in `pkarr_publish.rs` — it calls both functions and should also pass `None` for now.

**Step 6: Verify compilation**

```bash
cd core && cargo check 2>&1
```

Expected: compiles with 0 errors.

**Step 7: Commit**

```bash
git add core/src/pkarr_publish.rs core/src/lib.rs
git commit -m "feat(core): add relay_z32 field to pkarr TXT records (wired as None for now)"
```

---

## Task 5: App layer — Upload avatar blob to relay before publishing profile

**Files:**
- Modify: `app/src/stores/useProfileStore.ts`
- Modify: `app/src/stores/useOrgsStore.ts`

The app already knows the relay URL (passed to `initNetwork`). The relay's z32 public key can be fetched via `GET {relayUrl}/pubkey`. We upload the blob via `PUT {relayUrl}/public-blob/{blobId}` then pass the relay z32 into pkarr publishing.

Note: For now the relay z32 is stored in pkarr but the Rust core just accepts it as `Option<String>` via a new UDL-exposed parameter. We'll wire the relay z32 through the FFI in sub-steps.

**Step 1: Read the current createOrUpdateProfile call in useProfileStore**

Check `app/src/stores/useProfileStore.ts` to understand the current call signature and where the avatar blob upload happens.

**Step 2: Add uploadAvatarToRelay helper in useProfileStore.ts**

Add this helper function before the store:

```typescript
const DEFAULT_RELAY_URL = 'https://gardens-relay.stereos.workers.dev';

async function uploadBlobToRelay(
  blobBytes: Uint8Array,
  blobId: string,
  mimeType: string,
  relayBaseUrl: string,
): Promise<void> {
  const resp = await fetch(`${relayBaseUrl}/public-blob/${blobId}`, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: blobBytes,
  });
  if (!resp.ok && resp.status !== 409) {
    // 409 = already stored, that's fine
    throw new Error(`Failed to upload blob to relay: ${resp.status}`);
  }
}

async function getRelayZ32(relayBaseUrl: string): Promise<string> {
  const resp = await fetch(`${relayBaseUrl}/pubkey`);
  if (!resp.ok) throw new Error('Failed to get relay pubkey');
  const pubkeyHex = await resp.text();
  // Convert hex pubkey to z32 via gardensCore
  return getPkarrUrlFromZ32(/* need z32 of pubkey hex */);
}
```

Wait — converting a hex pubkey to z32 requires a function. `getPkarrUrl(publicKeyHex)` in gardensCore already does this (it takes hex and returns `pk:<z32>`). So:

```typescript
async function getRelayZ32(relayBaseUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(`${relayBaseUrl}/pubkey`);
    if (!resp.ok) return null;
    const pubkeyHex = (await resp.text()).trim();
    const pkarrUrl = getPkarrUrl(pubkeyHex); // returns "pk:<z32>"
    return pkarrUrl.replace('pk:', '');       // strip prefix
  } catch {
    return null;
  }
}
```

**Step 3: Wire into profile publishing**

In `useProfileStore.ts`, find where `createOrUpdateProfile` is called with `isPublic: true` and an avatar. After uploading the avatar blob locally, also upload to relay:

```typescript
// After getting avatarBlobId and bytes:
if (isPublic && avatarBlobId && avatarBytes) {
  try {
    await uploadBlobToRelay(avatarBytes, avatarBlobId, 'image/jpeg', DEFAULT_RELAY_URL);
  } catch (e) {
    console.warn('[blob] Failed to upload avatar to relay:', e);
    // non-fatal — profile still publishes, avatar just won't show on web
  }
}
```

**Step 4: Do the same in useOrgsStore.ts for org avatars**

Find where org avatar blobs are uploaded (in `OrgSettingsScreen` or the org store), and add relay upload after local upload succeeds.

**Step 5: Test manually**

1. Set a profile avatar and mark profile as public
2. Check relay: `curl https://gardens-relay.stereos.workers.dev/public-blob/<blobId>`
3. Expected: returns the image bytes

**Step 6: Commit**

```bash
git add app/src/stores/useProfileStore.ts app/src/stores/useOrgsStore.ts
git commit -m "feat(app): upload public avatar blobs to relay on profile publish"
```

---

## Task 6: Web pkarr — Parse rl= field from TXT records

**Files:**
- Modify: `web/src/pkarr.ts`

**Step 1: Add relayZ32 to ResolvedRecord interface**

```typescript
export interface ResolvedRecord {
  recordType: 'user' | 'org' | 'relay' | 'none';
  name?: string;
  username?: string;
  description?: string;
  bio?: string;
  avatarBlobId?: string;
  coverBlobId?: string;
  relayUrl?: string;
  relayPubkey?: string;
  relayZ32?: string;       // ← ADD: z32 pubkey of the owner's relay
  publicKey: string;
}
```

**Step 2: Parse rl= in parseGardensRecord**

In the `match key` block inside `parseGardensRecord`:

```typescript
case 'rl': record.relayZ32 = value; break;
```

Full updated switch (add rl after existing cases):

```typescript
for (const part of txt.split(';')) {
  const eq = part.indexOf('=');
  if (eq !== -1) {
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    switch (key) {
      case 't': record.recordType = value as ResolvedRecord['recordType']; break;
      case 'u': record.username = value; break;
      case 'n': record.name = value; break;
      case 'b': record.bio = value; break;
      case 'd': record.description = value; break;
      case 'a': record.avatarBlobId = value; break;
      case 'c': record.coverBlobId = value; break;
      case 'rl': record.relayZ32 = value; break;
    }
  }
}
```

(Note: the existing code uses a different style — match it to what's already there.)

**Step 3: Verify TypeScript compiles**

```bash
cd web && npm run typecheck
```

Expected: 0 errors.

**Step 4: Commit**

```bash
git add web/src/pkarr.ts
git commit -m "feat(web/pkarr): parse rl= relay z32 field from TXT records"
```

---

## Task 7: Web gateway — Rewrite /blob/:blobId as P2P passthrough

**Files:**
- Modify: `web/src/index.ts`

Replace the current stub `/blob/:blobId` handler with a full implementation that:
1. Accepts `?owner=<z32Key>` query param
2. Resolves pkarr for owner → gets `relayZ32`
3. Resolves pkarr for `relayZ32` → gets relay hop URL → strips `/hop` → base URL
4. Validates relay URL (SSRF protection)
5. Fetches `{relayBaseUrl}/public-blob/{blobId}`
6. Verifies sha256(response) === blobId
7. Streams with immutable cache headers

**Step 1: Install @noble/hashes in web package**

```bash
cd web && npm install @noble/hashes
```

Check `web/package.json` — if already there, skip.

**Step 2: Write the handler**

Replace the existing `/blob/:blobId` route in `web/src/index.ts`:

```typescript
import { sha256 } from '@noble/hashes/sha256';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Block private/internal relay URLs to prevent SSRF */
function isSafeRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    // Block loopback, link-local, private ranges
    if (host === 'localhost') return false;
    if (host.endsWith('.local')) return false;
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    if (host === '0.0.0.0') return false;
    return true;
  } catch {
    return false;
  }
}

app.get('/blob/:blobId', async (c) => {
  const blobId = c.req.param('blobId');
  const ownerZ32 = c.req.query('owner');

  // Validate blobId is a sha256 hex string
  if (!/^[0-9a-f]{64}$/i.test(blobId)) {
    return c.body(null, 400);
  }

  if (!ownerZ32) {
    return c.body(null, 400);
  }

  // Step 1: Resolve owner's pkarr record to get their relay's z32 key
  const ownerRecord = await resolvePkarr(ownerZ32);
  if (!ownerRecord?.relayZ32) {
    return c.body(null, 404);
  }

  // Step 2: Resolve relay's pkarr record to get its hop URL
  const relayRecord = await resolvePkarr(ownerRecord.relayZ32);
  if (!relayRecord || relayRecord.recordType !== 'relay' || !relayRecord.relayUrl) {
    return c.body(null, 404);
  }

  // Step 3: Derive base relay URL from hop URL (strip /hop suffix)
  const relayBaseUrl = relayRecord.relayUrl.replace(/\/hop$/, '');

  // Step 4: SSRF protection
  if (!isSafeRelayUrl(relayBaseUrl)) {
    console.warn(`[blob] Blocked unsafe relay URL: ${relayBaseUrl}`);
    return c.body(null, 400);
  }

  // Step 5: Fetch blob from relay
  let upstream: Response;
  try {
    upstream = await fetch(`${relayBaseUrl}/public-blob/${blobId}`);
  } catch {
    return c.body(null, 502);
  }

  if (!upstream.ok) {
    return c.body(null, upstream.status === 404 ? 404 : 502);
  }

  // Step 6: Read bytes and verify sha256 matches blobId
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const computedHash = toHex(sha256(bytes));
  if (computedHash !== blobId.toLowerCase()) {
    console.error(`[blob] Hash mismatch for ${blobId}: got ${computedHash}`);
    return c.body(null, 502);
  }

  // Step 7: Serve with immutable caching (content-addressed = safe to cache forever)
  return new Response(bytes, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});
```

Also remove the `BLOB_BASE_URL` field from `Env` since we no longer need it:

```typescript
interface Env {
  APP_SCHEME: string;
  APP_STORE_URL?: string;
  PLAY_STORE_URL?: string;
  // BLOB_BASE_URL removed — blobs are proxied via owner's relay
}
```

**Step 3: Verify TypeScript compiles**

```bash
cd web && npm run typecheck
```

Expected: 0 errors.

**Step 4: Commit**

```bash
git add web/src/index.ts web/package.json web/package-lock.json
git commit -m "feat(web): P2P blob passthrough via owner relay with sha256 verification and SSRF protection"
```

---

## Task 8: Template — Update avatar URLs to use gateway passthrough

**Files:**
- Modify: `web/src/template.ts`

**Step 1: Update renderProfilePage avatar URL**

Find:
```typescript
const avatarUrl = record.avatarBlobId
  ? `/blob/${record.avatarBlobId}`
  : null;
```

Change to:
```typescript
const avatarUrl = record.avatarBlobId && record.relayZ32
  ? `/blob/${record.avatarBlobId}?owner=${record.publicKey}`
  : null;
```

**Step 2: Update renderOrgPage avatar URL identically**

Same change in `renderOrgPage`.

**Step 3: Fix og:image to use absolute URL**

Open Graph image tags must be absolute URLs. Update both render functions to pass an absolute URL for `og:image`. In `handleProfileRequest` in `index.ts`, the request context `c` has the URL. Pass the gateway's origin into render options.

In `web/src/index.ts`, update `RenderOptions` and `handleProfileRequest`:

```typescript
// In template.ts, add to RenderOptions:
interface RenderOptions {
  appUrl: string;
  appStoreUrl?: string;
  playStoreUrl?: string;
  gatewayOrigin: string;  // ← ADD
}
```

Update `handleProfileRequest` in `index.ts`:

```typescript
const options = {
  appUrl,
  appStoreUrl: c.env.APP_STORE_URL,
  playStoreUrl: c.env.PLAY_STORE_URL,
  gatewayOrigin: new URL(c.req.url).origin,
};
```

In `renderProfilePage` and `renderOrgPage`, use absolute URL for og:image:

```typescript
const avatarUrl = record.avatarBlobId && record.relayZ32
  ? `/blob/${record.avatarBlobId}?owner=${record.publicKey}`
  : null;

const ogImageUrl = avatarUrl
  ? `${options.gatewayOrigin}${avatarUrl}`
  : null;
```

Then in the `<head>`:
```html
${ogImageUrl ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}">` : ''}
```

**Step 4: Verify TypeScript compiles**

```bash
cd web && npm run typecheck
```

Expected: 0 errors.

**Step 5: Commit**

```bash
git add web/src/template.ts web/src/index.ts
git commit -m "feat(web/template): use P2P blob passthrough URLs for avatars, absolute og:image"
```

---

## Task 9: End-to-end smoke test

**Step 1: Deploy relay**

```bash
cd relay && npm run deploy
```

**Step 2: Test blob upload and retrieval directly**

```bash
# Upload a test blob
BLOB_CONTENT="test avatar content"
BLOB_HASH=$(echo -n "$BLOB_CONTENT" | sha256sum | cut -d' ' -f1)
echo -n "$BLOB_CONTENT" | curl -X PUT \
  "https://gardens-relay.stereos.workers.dev/public-blob/$BLOB_HASH" \
  -H "Content-Type: text/plain" \
  --data-binary @- -v

# Retrieve it
curl "https://gardens-relay.stereos.workers.dev/public-blob/$BLOB_HASH"
```

Expected: PUT → 204, GET → `test avatar content`

**Step 3: Deploy web gateway**

```bash
cd web && npm run deploy
```

**Step 4: Test blob passthrough**

Using a real profile's z32 key and avatar blob id from the debug endpoint:

```bash
curl "https://gardens-web-gateway.stereos.workers.dev/debug/pkarr/<user-z32-key>"
# Note the avatarBlobId and publicKey from the response

curl "https://gardens-web-gateway.stereos.workers.dev/blob/<avatarBlobId>?owner=<user-z32-key>"
```

Expected: returns image bytes with correct Content-Type.

**Step 5: View a profile page**

Navigate to `https://gardens-web-gateway.stereos.workers.dev/pk/<user-z32-key>` in a browser.

Expected: profile page renders with avatar image visible (not just the placeholder initials).

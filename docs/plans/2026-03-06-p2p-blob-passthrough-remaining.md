# P2P Blob Passthrough — Remaining Work

Full plan: `docs/plans/2026-03-06-p2p-blob-passthrough.md`

## Completed

- ✅ Task 1: `relay/wrangler.toml` — `PUBLIC_BLOBS` KV namespace created and bound
- ✅ Task 2: `relay/src/index.ts` — `PUT /public-blob/:blobId` with sha256 verification, 2MB limit, KV storage
- ✅ Task 3: `relay/src/index.ts` — `GET /public-blob/:blobId` serving from KV with immutable cache headers
- ✅ Task 4: `core/src/pkarr_publish.rs` — `relay_z32: Option<&str>` added; `rl=` field emitted; tests for relay field present/absent already exist in `#[cfg(test)]` block
- ✅ Task 5: `app/src/stores/useProfileStore.ts` + `useOrgsStore.ts` — `uploadBlobToRelay`/`getRelayZ32` helpers added; avatar/cover blobs uploaded to relay when publishing public profiles/orgs
- ✅ Task 6: `web/src/pkarr.ts` — `relayZ32?: string` added to `ResolvedRecord`; `rl=` field parsed in `parseGardensRecord`
- ✅ Task 7: `web/src/index.ts` — `/blob/:blobId` rewritten as P2P passthrough (owner pkarr → relay pkarr → fetch → sha256 verify via Web Crypto); SSRF guard; `BLOB_BASE_URL` removed from `Env`
- ✅ Task 8: `web/src/template.ts` + `web/src/index.ts` — `avatarUrl` requires `relayZ32`; `?owner=` param added; `og:image` uses absolute URL via `gatewayOrigin`

## Remaining
Add two unit tests to `core/src/pkarr_publish.rs` `#[cfg(test)]` block:
```rust
#[test]
fn user_txt_record_includes_relay_when_some() {
    let record = build_user_txt_record("alice", None, None, Some("abc123relay"));
    assert!(record.ends_with(";rl=abc123relay"), "got: {}", record);
}

#[test]
fn user_txt_record_omits_relay_when_none() {
    let record = build_user_txt_record("alice", None, None, None);
    assert!(!record.contains("rl="), "got: {}", record);
}
```

---

### Task 5: App layer — Upload avatar blob to relay before publishing profile

**Files:** `app/src/stores/useProfileStore.ts`, `app/src/stores/useOrgsStore.ts`

Add two helpers before the store definition in `useProfileStore.ts`:

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
    throw new Error(`Failed to upload blob to relay: ${resp.status}`);
  }
}

async function getRelayZ32(relayBaseUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(`${relayBaseUrl}/pubkey`);
    if (!resp.ok) return null;
    const pubkeyHex = (await resp.text()).trim();
    const pkarrUrl = getPkarrUrl(pubkeyHex); // returns "pk:<z32>"
    return pkarrUrl.replace('pk:', '');
  } catch {
    return null;
  }
}
```

When publishing a public profile with an avatar, call `uploadBlobToRelay` (non-fatal — log warning if it fails). Do the same in `useOrgsStore.ts` for org avatar blobs.

The relay's pubkey endpoint (`GET /pubkey`) already exists on the relay — it returns hex. `getPkarrUrl` is already in gardensCore FFI.

---

### Task 6: Web pkarr — Parse rl= field from TXT records

**File:** `web/src/pkarr.ts`

Add to `ResolvedRecord` interface:
```typescript
relayZ32?: string;  // z32 pubkey of the owner's relay
```

In `parseGardensRecord`, add a case to handle `rl=` (check existing parsing style — it uses either `if/else` chains or a `switch`):
```typescript
case 'rl': record.relayZ32 = value; break;
```

Run `cd web && npm run typecheck` — expect 0 errors.

---

### Task 7: Web gateway — Rewrite /blob/:blobId as P2P passthrough

**File:** `web/src/index.ts`

Install `@noble/hashes` if not present: `cd web && npm install @noble/hashes`

Replace the current stub `/blob/:blobId` handler with:

```typescript
import { sha256 } from '@noble/hashes/sha256';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isSafeRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const h = parsed.hostname;
    if (h === 'localhost' || h.endsWith('.local')) return false;
    if (/^127\./.test(h)) return false;
    if (/^10\./.test(h)) return false;
    if (/^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (/^169\.254\./.test(h)) return false;
    if (h === '0.0.0.0') return false;
    return true;
  } catch { return false; }
}

app.get('/blob/:blobId', async (c) => {
  const blobId = c.req.param('blobId');
  const ownerZ32 = c.req.query('owner');

  if (!/^[0-9a-f]{64}$/i.test(blobId)) return c.body(null, 400);
  if (!ownerZ32) return c.body(null, 400);

  // 1. Resolve owner's pkarr record → get relay z32
  const ownerRecord = await resolvePkarr(ownerZ32);
  if (!ownerRecord?.relayZ32) return c.body(null, 404);

  // 2. Resolve relay's pkarr record → get hop URL → strip /hop
  const relayRecord = await resolvePkarr(ownerRecord.relayZ32);
  if (!relayRecord || relayRecord.recordType !== 'relay' || !relayRecord.relayUrl) {
    return c.body(null, 404);
  }
  const relayBaseUrl = relayRecord.relayUrl.replace(/\/hop$/, '');

  // 3. SSRF protection
  if (!isSafeRelayUrl(relayBaseUrl)) return c.body(null, 400);

  // 4. Fetch blob from relay
  let upstream: Response;
  try {
    upstream = await fetch(`${relayBaseUrl}/public-blob/${blobId}`);
  } catch { return c.body(null, 502); }

  if (!upstream.ok) return c.body(null, upstream.status === 404 ? 404 : 502);

  // 5. Verify sha256 matches blobId
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (toHex(sha256(bytes)) !== blobId.toLowerCase()) return c.body(null, 502);

  return new Response(bytes, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});
```

Also remove `BLOB_BASE_URL?: string` from the `Env` interface.

Run `cd web && npm run typecheck` — expect 0 errors.

---

### Task 8: Template — Update avatar URLs to use gateway passthrough

**File:** `web/src/template.ts`, `web/src/index.ts`

In `web/src/template.ts`, find the two places that build `avatarUrl` and change:
```typescript
// before
const avatarUrl = record.avatarBlobId ? `/blob/${record.avatarBlobId}` : null;

// after
const avatarUrl = record.avatarBlobId && record.relayZ32
  ? `/blob/${record.avatarBlobId}?owner=${record.publicKey}`
  : null;
```

Add `gatewayOrigin: string` to `RenderOptions` interface in `template.ts`.

In the `og:image` meta tag, use absolute URL:
```typescript
const ogImageUrl = avatarUrl ? `${options.gatewayOrigin}${avatarUrl}` : null;
// <meta property="og:image" content="${escapeHtml(ogImageUrl)}">
```

In `web/src/index.ts`, update `handleProfileRequest` to pass:
```typescript
const options = {
  appUrl,
  appStoreUrl: c.env.APP_STORE_URL,
  playStoreUrl: c.env.PLAY_STORE_URL,
  gatewayOrigin: new URL(c.req.url).origin,
};
```

Run `cd web && npm run typecheck` — expect 0 errors.

---

### Task 9: End-to-end smoke test

After deploying relay (`cd relay && npm run deploy`) and web gateway (`cd web && npm run deploy`):

```bash
# Test PUT/GET directly on relay
CONTENT="test avatar content"
HASH=$(echo -n "$CONTENT" | shasum -a 256 | cut -d' ' -f1)
echo -n "$CONTENT" | curl -X PUT \
  "https://gardens-relay.stereos.workers.dev/public-blob/$HASH" \
  -H "Content-Type: text/plain" --data-binary @- -v
curl "https://gardens-relay.stereos.workers.dev/public-blob/$HASH"

# Test passthrough via web gateway (with a real user z32 + avatar)
curl "https://gardens-web-gateway.stereos.workers.dev/debug/pkarr/<user-z32>"
curl "https://gardens-web-gateway.stereos.workers.dev/blob/<blobId>?owner=<user-z32>"
```

Then visit `https://gardens-web-gateway.stereos.workers.dev/pk/<user-z32>` in a browser — avatar should render.

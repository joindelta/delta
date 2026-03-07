# Bidirectional Email Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up full bidirectional email for Gardens users (send + receive) and org inbound email using Cloudflare Email Routing, Ed25519-signed outbound payloads, and a new Inbox screen.

**Architecture:** Inbound email arrives via Cloudflare Email Routing's `email` Worker handler, parsed with PostalMime, and delivered to a per-identity inbox topic via the sync worker. Outbound email is signed by core using the user's Ed25519 private key, POSTed to `relay/send-email`, verified by the relay, then sent via the `[[send_email]]` Worker binding.

**Tech Stack:** Rust (core), UniFFI, React Native (TypeScript), Cloudflare Workers, `postal-mime`, `mimetext`, `@noble/curves/ed25519`, `z32`, `blake3`

---

## Task 1: Core — add `email` field to pkarr TXT records

**Files:**
- Modify: `core/src/pkarr_publish.rs`

### Step 1: Add `email` parameter to `build_user_txt_record`

Find the function signature:
```rust
fn build_user_txt_record(
    username: &str,
    bio: Option<&str>,
    avatar_blob_id: Option<&str>,
    relay_z32: Option<&str>,
) -> String {
```

Change it to:
```rust
fn build_user_txt_record(
    username: &str,
    bio: Option<&str>,
    avatar_blob_id: Option<&str>,
    relay_z32: Option<&str>,
    email_enabled: bool,
) -> String {
```

Then at the end of the function body, before `parts.join(";")`, add:
```rust
    if email_enabled {
        parts.push("email=1".to_string());
    }
```

### Step 2: Add `email_enabled` to `build_org_txt_record`

Same pattern — add `email_enabled: bool` parameter and `if email_enabled { parts.push("email=1".to_string()); }` before the join.

### Step 3: Update `publish_profile` signature

Add `email_enabled: bool` as a parameter and pass it through to `build_user_txt_record`.

### Step 4: Update `publish_org_with_key` signature

Add `email_enabled: bool` as a parameter and pass it through to `build_org_txt_record`.

### Step 5: Update `publish_org` (legacy wrapper) to pass `false`

The call inside `publish_org` to `publish_org_with_key` needs `false` for `email_enabled`.

### Step 6: Update `republish_all` callers

In `republish_all`, both `publish_profile(...)` and `publish_org_with_key(...)` calls need an `email_enabled` argument. For now pass `false` as a placeholder — Task 2 adds the DB column that will make this dynamic.

### Step 7: Run tests

```bash
cd core && cargo test pkarr 2>&1 | head -40
```
Expected: all existing pkarr tests pass (they don't test the email flag yet).

### Step 8: Commit
```bash
git add core/src/pkarr_publish.rs
git commit -m "feat(core): add email_enabled flag to pkarr TXT records"
```

---

## Task 2: Core — add `email` field to `PkarrResolvedRecord` and parser

**Files:**
- Modify: `core/src/pkarr_publish.rs`

### Step 1: Add `email` field to `PkarrResolvedRecord`

Find the struct definition and add:
```rust
pub struct PkarrResolvedRecord {
    // ...existing fields...
    pub email: bool,  // true if email=1 is present in TXT record
}
```

### Step 2: Initialize `email: false` in `parse_txt_record`

In the `PkarrResolvedRecord` initializer inside `parse_txt_record`:
```rust
let mut record = PkarrResolvedRecord {
    // ...existing fields...
    email: false,
};
```

### Step 3: Parse `email` in the match arm

In the `for part in txt.split(';')` loop, add:
```rust
"email" => record.email = value == "1",
```

### Step 4: Update `PkarrResolved` dictionary in UDL

In `core/src/gardens_core.udl`, find the `PkarrResolved` dictionary and add:
```
dictionary PkarrResolved {
    // ...existing fields...
    boolean email;
};
```

### Step 5: Update `PkarrResolved` interface in `gardensCore.ts`

In `app/src/ffi/gardensCore.ts`, find `export interface PkarrResolved` and add:
```typescript
email: boolean;
```

### Step 6: Write a test

In `core/src/pkarr_publish.rs` tests block, add:
```rust
#[test]
fn parse_email_flag_present() {
    let txt = "v=gardens1;t=user;u=alice;email=1";
    let record = parse_txt_record(txt, "testz32key").unwrap();
    assert!(record.email);
}

#[test]
fn parse_email_flag_absent() {
    let txt = "v=gardens1;t=user;u=alice";
    let record = parse_txt_record(txt, "testz32key").unwrap();
    assert!(!record.email);
}
```

### Step 7: Run tests
```bash
cd core && cargo test pkarr 2>&1 | head -40
```
Expected: 2 new tests pass plus all existing ones.

### Step 8: Commit
```bash
git add core/src/pkarr_publish.rs core/src/gardens_core.udl app/src/ffi/gardensCore.ts
git commit -m "feat(core): parse email=1 flag from pkarr TXT records"
```

---

## Task 3: Core — wire `email_enabled` through profile + org update

**Files:**
- Modify: `core/src/gardens_core.udl`
- Modify: `core/src/lib.rs`
- Modify: `core/src/db.rs` (add column if needed)

### Step 1: Add `email_enabled` to `create_or_update_profile` in UDL

Find:
```
void create_or_update_profile(string username, string? bio, sequence<string> available_for, boolean is_public, string? avatar_blob_id);
```
Change to:
```
void create_or_update_profile(string username, string? bio, sequence<string> available_for, boolean is_public, string? avatar_blob_id, boolean email_enabled);
```

### Step 2: Update `lib.rs` `create_or_update_profile` function

Add `email_enabled: bool` parameter. When calling `publish_profile(...)`, pass `email_enabled`. Also store `email_enabled` in the `profiles` table row.

You will need to add `email_enabled` column to the profiles table. In `db.rs` or wherever migrations live, add:
```sql
ALTER TABLE profiles ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0;
```
This is typically done in the `init_db` / migration function — add it alongside the existing `CREATE TABLE` or as an `ALTER TABLE` if the table already exists.

### Step 3: Add `email_enabled` to `update_org` in UDL

Find the `update_org` signature in `gardens_core.udl` and add `boolean? email_enabled` as the last parameter.

### Step 4: Update `lib.rs` `update_org` function

Add `email_enabled: Option<bool>` parameter. When `email_enabled` is `Some(true)`, call `publish_org_with_key(...)` with `email_enabled = true`. Store in `organizations` table.

Add column migration:
```sql
ALTER TABLE organizations ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0;
```

### Step 5: Update `republish_all` to read `email_enabled` from DB

In `pkarr_publish.rs` `republish_all`, update the SQL queries:
- Profile query: add `email_enabled` to SELECT, pass to `publish_profile`
- Org query: add `email_enabled` to SELECT, pass to `publish_org_with_key`

### Step 6: Update `createOrUpdateProfile` in `gardensCore.ts`

Add `emailEnabled: boolean` parameter to both the `GardensCoreNative` interface and the exported wrapper. Add stub `async createOrUpdateProfile(..., _e: boolean) { throw ... }` to fallback.

### Step 7: Update `useProfileStore` callers of `createOrUpdateProfile`

In `app/src/stores/useProfileStore.ts`, find all calls to `createOrUpdateProfile` and add `false` as `emailEnabled` for now (the Settings screen will pass the real value in Task 12).

### Step 8: Update `updateOrg` in `gardensCore.ts`

Add `emailEnabled: boolean | null` as last param to both the native interface and the exported wrapper. Update stub.

### Step 9: Update `useOrgsStore` callers of `updateOrg`

In `app/src/stores/useOrgsStore.ts`, add `emailEnabled?: boolean | null` to the `updateOrg` store method signature and pass it through to `dcUpdateOrg`.

### Step 10: Build check
```bash
cd core && cargo build 2>&1 | grep -E "^error" | head -20
```
Fix any compilation errors.

### Step 11: Commit
```bash
git add core/src/gardens_core.udl core/src/lib.rs core/src/db.rs core/src/pkarr_publish.rs \
        app/src/ffi/gardensCore.ts app/src/stores/useProfileStore.ts app/src/stores/useOrgsStore.ts
git commit -m "feat(core): wire email_enabled through profile and org update"
```

---

## Task 4: Core — implement `prepare_outbound_email`

**Files:**
- Modify: `core/src/gardens_core.udl`
- Modify: `core/src/lib.rs`

### Step 1: Add to UDL

In `core/src/gardens_core.udl`, add to the namespace block (near other profile functions):
```
[Throws=CoreError]
string prepare_outbound_email(
    string to,
    string subject,
    string body_text,
    string? body_html,
    string? reply_to_message_id
);
```

### Step 2: Implement in `lib.rs`

Add this function to the `impl GardensCore` block:

```rust
pub fn prepare_outbound_email(
    &self,
    to: String,
    subject: String,
    body_text: String,
    body_html: Option<String>,
    reply_to_message_id: Option<String>,
) -> Result<String, CoreError> {
    use ed25519_dalek::{SigningKey, Signer};

    let core = get_core().ok_or(CoreError::NotInitialised)?;
    let private_key_bytes = hex::decode(core.private_key.to_hex())
        .map_err(|_| CoreError::InvalidInput)?;
    let key_arr: [u8; 32] = private_key_bytes.as_slice().try_into()
        .map_err(|_| CoreError::InvalidInput)?;

    // Derive from_z32 using pkarr keypair (same as profile publishing)
    let pkarr_keypair = pkarr::Keypair::from_secret_key(&key_arr);
    let from_z32 = pkarr_keypair.to_z32();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| CoreError::InvalidInput)?
        .as_millis() as i64;

    let payload = serde_json::json!({
        "from_z32": from_z32,
        "to": to,
        "subject": subject,
        "body_text": body_text,
        "body_html": body_html,
        "reply_to_message_id": reply_to_message_id,
        "timestamp": timestamp,
    });
    let payload_str = payload.to_string();

    let signing_key = SigningKey::from_bytes(&key_arr);
    let signature = signing_key.sign(payload_str.as_bytes());
    let signature_b64 = base64::engine::general_purpose::STANDARD
        .encode(signature.to_bytes());

    Ok(serde_json::json!({
        "signed_payload": payload_str,
        "signature": signature_b64,
    })
    .to_string())
}
```

### Step 3: Build check
```bash
cd core && cargo build 2>&1 | grep -E "^error" | head -20
```

### Step 4: Write a unit test

```rust
#[cfg(test)]
mod email_tests {
    // Note: prepare_outbound_email requires an initialized core state,
    // so this is an integration test — run it manually after init_core.
    // Unit test the JSON shape only:
    #[test]
    fn outbound_payload_is_valid_json() {
        let payload = serde_json::json!({
            "from_z32": "abc",
            "to": "alice@example.com",
            "subject": "Hi",
            "body_text": "Hello",
            "body_html": null,
            "reply_to_message_id": null,
            "timestamp": 1234567890i64,
        });
        assert_eq!(payload["to"], "alice@example.com");
    }
}
```

### Step 5: Commit
```bash
git add core/src/gardens_core.udl core/src/lib.rs
git commit -m "feat(core): implement prepare_outbound_email with Ed25519 signing"
```

---

## Task 5: App FFI — wire `prepareOutboundEmail`

**Files:**
- Modify: `app/src/ffi/gardensCore.ts`

### Step 1: Add to `GardensCoreNative` interface

```typescript
prepareOutboundEmail(
  to: string,
  subject: string,
  bodyText: string,
  bodyHtml: string | null,
  replyToMessageId: string | null,
): Promise<string>; // returns JSON: { signed_payload, signature }
```

### Step 2: Add stub to fallback object

```typescript
async prepareOutboundEmail() { throw new Error('gardens_core not loaded'); },
```

### Step 3: Add exported wrapper

```typescript
export async function prepareOutboundEmail(params: {
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  replyToMessageId?: string;
}): Promise<{ signedPayload: string; signature: string }> {
  const raw = await native.prepareOutboundEmail(
    params.to,
    params.subject,
    params.bodyText,
    params.bodyHtml ?? null,
    params.replyToMessageId ?? null,
  );
  return JSON.parse(raw);
}
```

### Step 4: Commit
```bash
git add app/src/ffi/gardensCore.ts
git commit -m "feat(app): add prepareOutboundEmail FFI wrapper"
```

---

## Task 6: Relay — install packages and add MIME builder

**Files:**
- Modify: `relay/package.json`
- Create: `relay/src/mime.ts`

### Step 1: Add dependencies to `relay/package.json`

```json
"dependencies": {
  "@noble/ciphers": "^1.0.0",
  "@noble/curves": "^1.6.0",
  "@noble/hashes": "^1.5.0",
  "dns-packet": "^5.6.1",
  "mimetext": "^3.0.0",
  "postal-mime": "^2.2.0",
  "z32": "^1.0.0"
}
```

### Step 2: Install
```bash
cd relay && npm install
```

### Step 3: Create `relay/src/mime.ts`

```typescript
// @ts-expect-error — mimetext has no bundled types
import { createMimeMessage } from 'mimetext';

export interface OutboundEmailPayload {
  from_z32: string;
  to: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  reply_to_message_id: string | null;
  timestamp: number;
}

const RELAY_DOMAIN = 'gardens-relay.stereos.workers.dev';

export function buildMime(payload: OutboundEmailPayload): string {
  const msg = createMimeMessage();
  msg.setSender(`${payload.from_z32}@${RELAY_DOMAIN}`);
  msg.setRecipient(payload.to);
  msg.setSubject(payload.subject);
  msg.addMessage({ contentType: 'text/plain', data: payload.body_text });

  if (payload.body_html) {
    msg.addMessage({ contentType: 'text/html', data: payload.body_html });
  }
  if (payload.reply_to_message_id) {
    msg.setHeader('In-Reply-To', payload.reply_to_message_id);
    msg.setHeader('References', payload.reply_to_message_id);
  }

  return msg.asRaw();
}
```

### Step 4: Write a test for `buildMime`

Create `relay/src/mime.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildMime } from './mime';

describe('buildMime', () => {
  it('includes From address with z32 key', () => {
    const raw = buildMime({
      from_z32: 'abc123',
      to: 'alice@example.com',
      subject: 'Hello',
      body_text: 'Hi there',
      body_html: null,
      reply_to_message_id: null,
      timestamp: 0,
    });
    expect(raw).toContain('abc123@gardens-relay.stereos.workers.dev');
    expect(raw).toContain('alice@example.com');
    expect(raw).toContain('Hello');
  });

  it('sets In-Reply-To when reply_to_message_id is provided', () => {
    const raw = buildMime({
      from_z32: 'abc123',
      to: 'alice@example.com',
      subject: 'Re: Hello',
      body_text: 'Sure!',
      body_html: null,
      reply_to_message_id: '<msg-id-123@mail.example.com>',
      timestamp: 0,
    });
    expect(raw).toContain('In-Reply-To: <msg-id-123@mail.example.com>');
  });
});
```

### Step 5: Run tests
```bash
cd relay && npm test 2>&1 | tail -20
```
Expected: mime tests pass.

### Step 6: Commit
```bash
git add relay/package.json relay/package-lock.json relay/src/mime.ts relay/src/mime.test.ts
git commit -m "feat(relay): add MIME builder for outbound email"
```

---

## Task 7: Relay — add `email` handler (inbound) and `POST /send-email`

**Files:**
- Modify: `relay/src/index.ts`
- Modify: `relay/wrangler.toml`

### Step 1: Add `[[send_email]]` binding to `relay/wrangler.toml`

At the end of the file add:
```toml
[[send_email]]
name = "EMAIL"
# No destination_address restriction — allows sending to any external address
```

### Step 2: Add `EMAIL` and `KV` bindings to the `Env` interface in `relay/src/index.ts`

Find:
```typescript
export interface Env {
  RELAY_SEED_HEX: string;
  SELF_URL?: string;
  PUBLIC_BLOBS: KVNamespace;
  SYNC_WORKER: Fetcher;
}
```
Change to:
```typescript
export interface Env {
  RELAY_SEED_HEX: string;
  SELF_URL?: string;
  PUBLIC_BLOBS: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  SYNC_WORKER: Fetcher;
  EMAIL: SendEmail;
}
```

### Step 3: Add `[[kv_namespaces]]` binding for rate limiting to `wrangler.toml`

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```
(The deployer fills in the real ID with `wrangler kv:namespace create RATE_LIMIT_KV`.)

### Step 4: Add imports to `relay/src/index.ts`

At the top, add:
```typescript
import PostalMime from 'postal-mime';
import z32 from 'z32';
import { blake3 } from '@noble/hashes/blake3';
import { buildMime, type OutboundEmailPayload } from './mime';
```

### Step 5: Add helper functions before the `export default`

```typescript
const RELAY_DOMAIN = 'gardens-relay.stereos.workers.dev';
const INBOX_SUFFIX = new TextEncoder().encode('gardens:inbox:v1');

function deriveInboxTopic(z32Key: string): string {
  const pubkey = z32.decode(z32Key);
  const input = new Uint8Array(pubkey.length + INBOX_SUFFIX.length);
  input.set(pubkey);
  input.set(INBOX_SUFFIX, pubkey.length);
  return bytesToHex(blake3(input));
}

interface EmailOp {
  op_type: string;
  from: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  message_id: string;
  received_at: number;
}

function encodeOp(op: EmailOp): string {
  return btoa(JSON.stringify(op));
}

async function resolvePkarrEmail(z32Key: string): Promise<{ email: boolean; type: string } | null> {
  try {
    const url = `https://pkarr.pubky.org/${z32Key}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    // Parse TXT records from the response (binary pkarr packet)
    // For simplicity, fetch and check for email=1 in the raw packet
    // Full DNS parsing not needed — just scan for the flag in the TXT value
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // The DNS TXT data is after the 72-byte header (64 sig + 8 timestamp)
    const dnsBytes = bytes.slice(72);
    const txtStr = new TextDecoder().decode(dnsBytes);
    const hasEmail = txtStr.includes('email=1');
    const isOrg = txtStr.includes('t=org');
    return { email: hasEmail, type: isOrg ? 'org' : 'user' };
  } catch {
    return null;
  }
}
```

### Step 6: Add `POST /send-email` handler inside the `fetch` function

After the existing blob handlers, before the final `return new Response('not found', { status: 404 })`:

```typescript
// ── POST /send-email — authenticated outbound email send ──────────────────
if (request.method === 'POST' && url.pathname === '/send-email') {
  const { signed_payload, signature } = await request.json() as {
    signed_payload: string;
    signature: string;
  };

  let payload: OutboundEmailPayload;
  try {
    payload = JSON.parse(signed_payload);
  } catch {
    return new Response('invalid payload', { status: 400 });
  }

  // Freshness check — reject payloads older than 5 minutes
  if (Date.now() - payload.timestamp > 5 * 60 * 1000) {
    return new Response('payload expired', { status: 400 });
  }

  // Verify Ed25519 signature
  try {
    const pubkeyBytes = z32.decode(payload.from_z32);
    const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    const msgBytes = new TextEncoder().encode(signed_payload);
    const valid = ed25519.verify(sigBytes, msgBytes, pubkeyBytes);
    if (!valid) return new Response('invalid signature', { status: 403 });
  } catch {
    return new Response('signature verification failed', { status: 403 });
  }

  // Rate limit: 50 emails/hour per from_z32 using KV
  const rateKey = `email_rate:${payload.from_z32}`;
  const currentCount = Number(await env.RATE_LIMIT_KV.get(rateKey) ?? 0);
  if (currentCount >= 50) {
    return new Response('rate limit exceeded', { status: 429 });
  }
  await env.RATE_LIMIT_KV.put(rateKey, String(currentCount + 1), { expirationTtl: 3600 });

  // Build and send MIME email
  const rawMime = buildMime(payload);
  const from = `${payload.from_z32}@${RELAY_DOMAIN}`;
  // @ts-expect-error — EmailMessage is a Cloudflare runtime global
  const msg = new EmailMessage(from, payload.to, rawMime);
  await env.EMAIL.send(msg);

  return new Response(null, { status: 200 });
}
```

### Step 7: Add `email` handler to the default export

Change:
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> { ... },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> { ... },
} satisfies ExportedHandler<Env>;
```
To:
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> { ... },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> { ... },

  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const localPart = message.to.split('@')[0];

    const record = await resolvePkarrEmail(localPart);
    if (!record?.email) {
      message.setReject('Recipient does not accept email');
      return;
    }

    const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());

    const op: EmailOp = {
      op_type: 'receive_email',
      from: message.from,
      subject: parsed.subject ?? '',
      body_text: parsed.text ?? '',
      body_html: parsed.html ?? null,
      message_id: parsed.messageId ?? crypto.randomUUID(),
      received_at: Date.now(),
    };

    const topic = deriveInboxTopic(localPart);

    try {
      await env.SYNC_WORKER.fetch('https://sync/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic_hex: topic, op_base64: encodeOp(op) }),
      });
    } catch {
      // Non-fatal
    }
  },
} satisfies ExportedHandler<Env>;
```

Note: `ForwardableEmailMessage` and `SendEmail` are Cloudflare Workers runtime types. They are available from `@cloudflare/workers-types`. If TypeScript complains, add `/// <reference types="@cloudflare/workers-types" />` at the top of `index.ts`.

### Step 8: Build check
```bash
cd relay && npx tsc --noEmit 2>&1 | head -30
```
Fix type errors.

### Step 9: Write a test for `/send-email` (without actual send — mock `env.EMAIL`)

In `relay/src/index.test.ts` (or similar), add:
```typescript
it('rejects expired payloads', async () => {
  const payload = JSON.stringify({
    from_z32: 'abc123',
    to: 'alice@example.com',
    subject: 'Hi',
    body_text: 'Hello',
    body_html: null,
    reply_to_message_id: null,
    timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago
  });
  const resp = await app.request('/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signed_payload: payload, signature: 'AAAA' }),
  });
  expect(resp.status).toBe(400);
});
```

### Step 10: Run tests
```bash
cd relay && npm test 2>&1 | tail -30
```

### Step 11: Commit
```bash
git add relay/src/index.ts relay/wrangler.toml relay/package.json relay/package-lock.json
git commit -m "feat(relay): add email handler (inbound) and /send-email endpoint"
```

---

## Task 8: App — create `useInboxStore`

**Files:**
- Create: `app/src/stores/useInboxStore.ts`

### Step 1: Write the store

```typescript
import { create } from 'zustand';
import { prepareOutboundEmail } from '../ffi/gardensCore';

const RELAY_URL = 'https://gardens-relay.stereos.workers.dev';

export interface InboxEmail {
  messageId: string;
  from: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: number;
  isRead: boolean;
}

interface InboxState {
  emails: InboxEmail[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
  fetchEmails(inboxTopicHex: string): Promise<void>;
  markRead(messageId: string): void;
  sendEmail(params: {
    to: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    replyToMessageId?: string;
  }): Promise<void>;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  emails: [],
  unreadCount: 0,
  isLoading: false,
  error: null,

  async fetchEmails(_inboxTopicHex) {
    // EmailOps are stored as messages with contentType='email' on the inbox topic.
    // For now, the inbox topic ops arrive via WebSocket (useSyncStore) and are
    // stored by ingestOp. We read them back from the projector using a dedicated
    // list_inbox_emails FFI (to be added in a later phase) or parse from raw ops.
    // Placeholder: in v1 the store is populated directly by the WebSocket handler
    // calling a parsed op callback. This will be wired in Task 9 (InboxScreen).
    set({ isLoading: false });
  },

  markRead(messageId) {
    set(s => {
      const updated = s.emails.map(e =>
        e.messageId === messageId ? { ...e, isRead: true } : e
      );
      return { emails: updated, unreadCount: updated.filter(e => !e.isRead).length };
    });
  },

  async sendEmail({ to, subject, bodyText, bodyHtml, replyToMessageId }) {
    const { signedPayload, signature } = await prepareOutboundEmail({
      to,
      subject,
      bodyText,
      bodyHtml,
      replyToMessageId,
    });

    const resp = await fetch(`${RELAY_URL}/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_payload: signedPayload, signature }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Send failed: ${resp.status} ${text}`);
    }
  },
}));

export function ingestEmailOp(rawOpJson: string): void {
  try {
    const op = JSON.parse(rawOpJson) as {
      op_type: string;
      from: string;
      subject: string;
      body_text: string;
      body_html: string | null;
      message_id: string;
      received_at: number;
    };
    if (op.op_type !== 'receive_email') return;
    const email: InboxEmail = {
      messageId: op.message_id,
      from: op.from,
      subject: op.subject,
      bodyText: op.body_text,
      bodyHtml: op.body_html,
      receivedAt: op.received_at,
      isRead: false,
    };
    useInboxStore.setState(s => {
      // Dedup by messageId
      if (s.emails.some(e => e.messageId === email.messageId)) return s;
      const updated = [email, ...s.emails].sort((a, b) => b.receivedAt - a.receivedAt);
      return { emails: updated, unreadCount: updated.filter(e => !e.isRead).length };
    });
  } catch {
    // Malformed op — ignore
  }
}
```

### Step 2: Commit
```bash
git add app/src/stores/useInboxStore.ts
git commit -m "feat(app): create useInboxStore for email inbox state"
```

---

## Task 9: App — create `InboxScreen`

**Files:**
- Create: `app/src/screens/InboxScreen.tsx`

### Step 1: Write the screen

```typescript
import React, { useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { SheetManager } from 'react-native-actions-sheet';
import { Mail, Plus } from 'lucide-react-native';
import { useInboxStore, ingestEmailOp } from '../stores/useInboxStore';
import { useSyncStore } from '../stores/useSyncStore';
import { useAuthStore } from '../stores/useAuthStore';

// Derive inbox topic hex from public key — must match relay's deriveInboxTopic
import { blake3 } from '@noble/hashes/blake3'; // add to app deps if not present
// OR: call a new FFI function get_inbox_topic_hex() — simpler for now:
function deriveInboxTopicHex(pubkeyHex: string): string {
  const pubkeyBytes = new Uint8Array(
    pubkeyHex.match(/.{2}/g)!.map(b => parseInt(b, 16))
  );
  const suffix = new TextEncoder().encode('gardens:inbox:v1');
  const input = new Uint8Array(pubkeyBytes.length + suffix.length);
  input.set(pubkeyBytes);
  input.set(suffix, pubkeyBytes.length);
  // blake3 import: add @noble/hashes to app/package.json if not already present
  const hash = blake3(input);
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function InboxScreen() {
  const { emails, unreadCount, markRead } = useInboxStore();
  const { subscribe, unsubscribe, opTick } = useSyncStore();
  const { publicKeyHex } = useAuthStore();

  const inboxTopic = publicKeyHex ? deriveInboxTopicHex(publicKeyHex) : null;

  useFocusEffect(
    useCallback(() => {
      if (!inboxTopic) return;
      subscribe(inboxTopic);
      return () => unsubscribe(inboxTopic);
    }, [inboxTopic])
  );

  // When any op arrives on inbox topic, check for email ops
  useEffect(() => {
    // opTick increments on each incoming op — re-render triggers list update
    // actual ingestion happens in useSyncStore's onmessage → ingestEmailOp
  }, [opTick]);

  const openEmail = (messageId: string) => {
    const email = emails.find(e => e.messageId === messageId);
    if (!email) return;
    markRead(messageId);
    SheetManager.show('email-detail-sheet', { payload: email });
  };

  const renderItem = ({ item }: { item: typeof emails[number] }) => (
    <TouchableOpacity style={styles.row} onPress={() => openEmail(item.messageId)}>
      <View style={styles.rowLeft}>
        {!item.isRead && <View style={styles.unreadDot} />}
        <View style={styles.rowText}>
          <Text style={[styles.from, !item.isRead && styles.bold]}>{item.from}</Text>
          <Text style={[styles.subject, !item.isRead && styles.bold]} numberOfLines={1}>
            {item.subject}
          </Text>
          <Text style={styles.preview} numberOfLines={1}>{item.bodyText}</Text>
        </View>
      </View>
      <Text style={styles.time}>
        {new Date(item.receivedAt).toLocaleDateString()}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={emails}
        keyExtractor={e => e.messageId}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Mail size={48} color="#444" />
            <Text style={styles.emptyText}>No messages yet</Text>
          </View>
        }
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => SheetManager.show('compose-email-sheet')}
      >
        <Plus size={24} color="#000" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
  },
  rowLeft: { flexDirection: 'row', flex: 1, alignItems: 'flex-start', gap: 8 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#F2E58F', marginTop: 6 },
  rowText: { flex: 1 },
  from: { color: '#aaa', fontSize: 12 },
  subject: { color: '#fff', fontSize: 15, marginTop: 2 },
  preview: { color: '#666', fontSize: 13, marginTop: 2 },
  bold: { fontWeight: '700' },
  time: { color: '#555', fontSize: 11 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 120, gap: 12 },
  emptyText: { color: '#555', fontSize: 15 },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#F2E58F',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
});
```

**Note about blake3 import:** Check if `@noble/hashes` is in `app/package.json`. If not:
```bash
cd app && npm install @noble/hashes
```

Alternatively, add `get_inbox_topic_hex()` to the core UDL (returns the topic hex for the current user) and call that instead — cleaner for native builds.

### Step 2: Commit
```bash
git add app/src/screens/InboxScreen.tsx
git commit -m "feat(app): add InboxScreen with email list and FAB"
```

---

## Task 10: App — create `ComposeEmailSheet` and `EmailDetailSheet`

**Files:**
- Create: `app/src/sheets/ComposeEmailSheet.tsx`
- Create: `app/src/sheets/EmailDetailSheet.tsx`
- Modify: `app/src/sheets/index.ts`

### Step 1: Create `ComposeEmailSheet`

```typescript
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import ActionSheet, { SheetProps } from 'react-native-actions-sheet';
import { useInboxStore } from '../stores/useInboxStore';
import { useAuthStore } from '../stores/useAuthStore';

const RELAY_DOMAIN = 'gardens-relay.stereos.workers.dev';

type ComposePayload = {
  to?: string;
  subject?: string;
  replyToMessageId?: string;
};

export function ComposeEmailSheet({ sheetId, payload }: SheetProps<'compose-email-sheet'>) {
  const p = (payload ?? {}) as ComposePayload;
  const [to, setTo] = useState(p.to ?? '');
  const [subject, setSubject] = useState(p.subject ?? '');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const { sendEmail } = useInboxStore();
  const { publicKeyHex } = useAuthStore();

  // Derive z32 from hex for display — simplified (real app uses core FFI)
  const fromDisplay = publicKeyHex
    ? `${publicKeyHex.slice(0, 20)}...@${RELAY_DOMAIN}`
    : `...@${RELAY_DOMAIN}`;

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      Alert.alert('Missing fields', 'Please fill in To, Subject, and Body.');
      return;
    }
    setSending(true);
    try {
      await sendEmail({
        to: to.trim(),
        subject: subject.trim(),
        bodyText: body.trim(),
        replyToMessageId: p.replyToMessageId,
      });
      SheetManager.hide(sheetId);
    } catch (e: unknown) {
      Alert.alert('Send failed', e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <ActionSheet id={sheetId} gestureEnabled>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>New Email</Text>
          <TouchableOpacity onPress={handleSend} disabled={sending} style={styles.sendBtn}>
            {sending
              ? <ActivityIndicator color="#000" size="small" />
              : <Text style={styles.sendText}>Send</Text>
            }
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>From</Text>
        <Text style={styles.fromAddr}>{fromDisplay}</Text>

        <Text style={styles.label}>To</Text>
        <TextInput
          style={styles.input}
          value={to}
          onChangeText={setTo}
          placeholder="recipient@example.com"
          placeholderTextColor="#555"
          autoCapitalize="none"
          keyboardType="email-address"
        />

        <Text style={styles.label}>Subject</Text>
        <TextInput
          style={styles.input}
          value={subject}
          onChangeText={setSubject}
          placeholder="Subject"
          placeholderTextColor="#555"
        />

        <TextInput
          style={styles.body}
          value={body}
          onChangeText={setBody}
          placeholder="Write your message..."
          placeholderTextColor="#555"
          multiline
          textAlignVertical="top"
        />
      </View>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#111', borderRadius: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  sendBtn: { backgroundColor: '#F2E58F', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  sendText: { color: '#000', fontWeight: '700' },
  label: { color: '#666', fontSize: 12, marginTop: 12, marginBottom: 4 },
  fromAddr: { color: '#888', fontSize: 13, marginBottom: 8 },
  input: { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, padding: 12, fontSize: 15 },
  body: { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, padding: 12, fontSize: 15, minHeight: 160, marginTop: 16 },
});
```

Add missing `SheetManager` import at top: `import { SheetManager } from 'react-native-actions-sheet';`

### Step 2: Create `EmailDetailSheet`

```typescript
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import ActionSheet, { SheetProps } from 'react-native-actions-sheet';
import { SheetManager } from 'react-native-actions-sheet';
import type { InboxEmail } from '../stores/useInboxStore';

export function EmailDetailSheet({ sheetId, payload }: SheetProps<'email-detail-sheet'>) {
  const email = payload as InboxEmail | undefined;
  if (!email) return null;

  const handleReply = () => {
    SheetManager.hide(sheetId);
    SheetManager.show('compose-email-sheet', {
      payload: {
        to: email.from,
        subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
        replyToMessageId: email.messageId,
      },
    });
  };

  return (
    <ActionSheet id={sheetId} gestureEnabled containerStyle={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.subject} numberOfLines={2}>{email.subject}</Text>
        <Text style={styles.from}>{email.from}</Text>
        <Text style={styles.date}>{new Date(email.receivedAt).toLocaleString()}</Text>
      </View>
      <ScrollView style={styles.body}>
        <Text style={styles.bodyText}>{email.bodyText}</Text>
      </ScrollView>
      <View style={styles.actions}>
        <TouchableOpacity style={styles.replyBtn} onPress={handleReply}>
          <Text style={styles.replyText}>Reply</Text>
        </TouchableOpacity>
      </View>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: '#111', borderRadius: 16 },
  header: { padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  subject: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  from: { color: '#aaa', fontSize: 14 },
  date: { color: '#555', fontSize: 12, marginTop: 4 },
  body: { maxHeight: 400 },
  bodyText: { color: '#ddd', fontSize: 15, lineHeight: 22, padding: 20 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', padding: 16 },
  replyBtn: { backgroundColor: '#F2E58F', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  replyText: { color: '#000', fontWeight: '700' },
});
```

### Step 3: Register sheets in `app/src/sheets/index.ts`

Open the file and add the two new sheets to the `SheetDefinition` map and export. The exact syntax depends on the existing pattern — follow it. It will look something like:

```typescript
export { ComposeEmailSheet } from './ComposeEmailSheet';
export { EmailDetailSheet } from './EmailDetailSheet';

declare module 'react-native-actions-sheet' {
  interface Sheets {
    // ...existing sheets...
    'compose-email-sheet': SheetDefinition<{ payload: { to?: string; subject?: string; replyToMessageId?: string } }>;
    'email-detail-sheet': SheetDefinition<{ payload: InboxEmail }>;
  }
}
```

### Step 4: Commit
```bash
git add app/src/sheets/ComposeEmailSheet.tsx app/src/sheets/EmailDetailSheet.tsx app/src/sheets/index.ts
git commit -m "feat(app): add ComposeEmailSheet and EmailDetailSheet"
```

---

## Task 11: App — add Inbox route to navigation

**Files:**
- Modify: `app/src/navigation/RootNavigator.tsx`

### Step 1: Add `Inbox` to `MainStackParamList`

```typescript
export type MainStackParamList = {
  // ...existing routes...
  Inbox: undefined;
};
```

### Step 2: Import `InboxScreen`

```typescript
import { InboxScreen } from '../screens/InboxScreen';
```

### Step 3: Add screen to `MainStack.Navigator`

```typescript
<MainStack.Screen
  name="Inbox"
  component={InboxScreen}
  options={{ title: 'Inbox', headerShown: true }}
/>
```

### Step 4: Add Inbox link to `HomeScreen` or nav header

In `HomeScreen` (or wherever the main navigation items live), add a button that navigates to `Inbox`. The exact location depends on the HomeScreen layout — add it alongside the Discover / DMs entries. Something like:

```typescript
<TouchableOpacity onPress={() => navigation.navigate('Inbox')}>
  <Text>Inbox</Text>
  {unreadCount > 0 && <View style={badge}><Text>{unreadCount}</Text></View>}
</TouchableOpacity>
```

Import `useInboxStore` to get `unreadCount` for the badge.

### Step 5: Commit
```bash
git add app/src/navigation/RootNavigator.tsx
git commit -m "feat(app): add Inbox route to navigation"
```

---

## Task 12: App — update UserSettingsScreen email section

**Files:**
- Modify: `app/src/screens/UserSettingsScreen.tsx`

### Step 1: Read the current file

Before editing, read the file to understand existing structure:
```bash
# or use Read tool
```

### Step 2: Add email state

Near other profile state:
```typescript
const [emailEnabled, setEmailEnabled] = useState(myProfile?.emailEnabled ?? false);
```

(This requires adding `emailEnabled?: boolean` to the `Profile` type in `gardensCore.ts` if not already there from Task 2.)

### Step 3: Add Email section UI

Find a good place in the settings list (after profile visibility / public settings) and add:

```typescript
{/* Email */}
<View style={styles.section}>
  <Text style={styles.sectionTitle}>Email</Text>
  <Text style={styles.sectionDesc}>
    Receive and send email at your public key address.
  </Text>

  {myProfile?.isPublic && (
    <>
      <View style={styles.addressRow}>
        <Text style={styles.addressText} numberOfLines={1}>
          {myPublicKeyZ32 ? `${myPublicKeyZ32}@gardens-relay.stereos.workers.dev` : '—'}
        </Text>
        <TouchableOpacity onPress={handleCopyAddress}>
          <Text style={styles.copyBtn}>Copy</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Send & receive email</Text>
        <Switch
          value={emailEnabled}
          onValueChange={handleToggleEmail}
          trackColor={{ true: '#F2E58F', false: '#333' }}
          thumbColor="#fff"
        />
      </View>
    </>
  )}

  {!myProfile?.isPublic && (
    <Text style={styles.hint}>
      Enable a public profile to use email.
    </Text>
  )}
</View>
```

### Step 4: Add handlers

```typescript
const handleCopyAddress = () => {
  Clipboard.setString(`${myPublicKeyZ32}@gardens-relay.stereos.workers.dev`);
};

const handleToggleEmail = async (value: boolean) => {
  setEmailEnabled(value);
  try {
    await createOrUpdateProfile(
      myProfile?.username ?? '',
      myProfile?.bio ?? null,
      myProfile?.availableFor ?? [],
      myProfile?.isPublic ?? false,
      myProfile?.avatarBlobId ?? null,
      value, // emailEnabled
    );
  } catch (e) {
    setEmailEnabled(!value); // revert on error
  }
};
```

### Step 5: Commit
```bash
git add app/src/screens/UserSettingsScreen.tsx
git commit -m "feat(app): add email send/receive toggle to UserSettings"
```

---

## Task 13: App — update OrgSettingsScreen email section

**Files:**
- Modify: `app/src/screens/OrgSettingsScreen.tsx`

### Step 1: Read the current file first

```bash
# use Read tool on app/src/screens/OrgSettingsScreen.tsx
```

### Step 2: Add org email state

```typescript
const [orgEmailEnabled, setOrgEmailEnabled] = useState(org?.emailEnabled ?? false);
```

(Requires `emailEnabled?: boolean` on `OrgSummary` type.)

### Step 3: Add Email section (receive-only)

```typescript
{/* Org Email */}
<View style={styles.section}>
  <Text style={styles.sectionTitle}>Org Email</Text>
  <Text style={styles.sectionDesc}>
    Receive email sent to your org's public key address.
    Messages appear in the #email channel (or #general).
  </Text>

  {org?.isPublic && (
    <>
      <View style={styles.addressRow}>
        <Text style={styles.addressText} numberOfLines={1}>
          {org.orgPubkey ? `${org.orgPubkey}@gardens-relay.stereos.workers.dev` : '—'}
        </Text>
        <TouchableOpacity onPress={() => Clipboard.setString(`${org?.orgPubkey}@gardens-relay.stereos.workers.dev`)}>
          <Text style={styles.copyBtn}>Copy</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Receive inbound email</Text>
        <Switch
          value={orgEmailEnabled}
          onValueChange={handleToggleOrgEmail}
          trackColor={{ true: '#F2E58F', false: '#333' }}
          thumbColor="#fff"
        />
      </View>
    </>
  )}
</View>
```

### Step 4: Add handler

```typescript
const handleToggleOrgEmail = async (value: boolean) => {
  setOrgEmailEnabled(value);
  try {
    await updateOrg(orgId, null, null, null, null, null, null, null, null, null, value);
  } catch {
    setOrgEmailEnabled(!value);
  }
};
```

### Step 5: Commit
```bash
git add app/src/screens/OrgSettingsScreen.tsx
git commit -m "feat(app): add receive-only email toggle to OrgSettings"
```

---

## Task 14: App — render email content type in ChannelMessage

**Files:**
- Modify: `app/src/components/ChannelMessage.tsx`

### Step 1: Read the current file

```bash
# use Read tool
```

### Step 2: Add email card render

Find where `contentType` is checked and add:

```typescript
if (message.contentType === 'email') {
  let emailData: { from?: string; subject?: string; body_text?: string } = {};
  try {
    emailData = JSON.parse(message.textContent ?? '{}');
  } catch { /* ignore */ }

  return (
    <View style={emailStyles.card}>
      <View style={emailStyles.header}>
        <Mail size={14} color="#888" />
        <Text style={emailStyles.from}>{emailData.from ?? 'Unknown sender'}</Text>
      </View>
      <Text style={emailStyles.subject}>{emailData.subject ?? '(no subject)'}</Text>
      <Text style={emailStyles.preview} numberOfLines={2}>{emailData.body_text ?? ''}</Text>
    </View>
  );
}
```

Add styles:
```typescript
const emailStyles = StyleSheet.create({
  card: { backgroundColor: '#1a1a1a', borderRadius: 8, padding: 12, borderLeftWidth: 3, borderLeftColor: '#F2E58F' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  from: { color: '#888', fontSize: 12 },
  subject: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 4 },
  preview: { color: '#666', fontSize: 13 },
});
```

### Step 3: Commit
```bash
git add app/src/components/ChannelMessage.tsx
git commit -m "feat(app): render email content type in ChannelMessage"
```

---

## Task 15: Wire inbox topic subscription to op ingestion in `useSyncStore`

**Files:**
- Modify: `app/src/stores/useSyncStore.ts`

### Step 1: Read the current file

The sync store's WebSocket `onmessage` handler calls `ingestOp` from `gardensCore.ts`. It needs to also call `ingestEmailOp` when the received op is an email op.

### Step 2: Import `ingestEmailOp`

```typescript
import { ingestEmailOp } from './useInboxStore';
```

### Step 3: In the WebSocket `onmessage` handler, after `ingestOp`, check for email ops

The current pattern receives `{ seq, op_base64 }` from the WebSocket. After calling `ingestOp`, add:

```typescript
// Try to parse as email op and route to inbox store
try {
  const decoded = atob(data.op_base64);
  const parsed = JSON.parse(decoded);
  if (parsed?.op_type === 'receive_email') {
    ingestEmailOp(decoded);
  }
} catch { /* not a JSON email op */ }
```

### Step 4: Commit
```bash
git add app/src/stores/useSyncStore.ts
git commit -m "feat(app): route email ops from sync WebSocket to useInboxStore"
```

---

## Verification

After all tasks:

1. **Core builds cleanly:**
   ```bash
   cd core && cargo build 2>&1 | grep "^error" | wc -l
   # Expected: 0
   ```

2. **Relay builds cleanly:**
   ```bash
   cd relay && npx tsc --noEmit && npm test
   # Expected: 0 type errors, all tests pass
   ```

3. **App builds cleanly (TypeScript):**
   ```bash
   cd app && npx tsc --noEmit 2>&1 | grep "^src" | wc -l
   # Expected: 0
   ```

4. **Manual test — outbound email:**
   - Enable email in UserSettings
   - Tap FAB on InboxScreen → fill compose form → send to a real external email
   - Verify it arrives in the external inbox with correct From address

5. **Manual test — inbound email:**
   - From an external email client, send to `<your-z32>@gardens-relay.stereos.workers.dev`
   - Verify it appears in InboxScreen within a few seconds

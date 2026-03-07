# Bidirectional Email via Pkarr + Cloudflare Email Routing

**Date:** 2026-03-06
**Status:** Design
**Scope:** Users (send + receive) · Orgs (receive only)

---

## Overview

Every Gardens identity already has a stable, self-sovereign public key published to the pkarr DHT. This design extends that identity to send and receive standard SMTP email — no domain registration, no email provider account required.

**User address format:**
```
<z32key>@gardens-relay.stereos.workers.dev
```

**Org address format:**
```
<org-z32key>@gardens-relay.stereos.workers.dev
```

**Custom domain (optional for both):**
```
hello@yourdomain.com  →  resolves via _gardens TXT → same delivery pipeline
```

Users get full bidirectional email: external senders can reach them, and users can compose and reply to external addresses from within Gardens. Orgs are receive-only — external people can contact an org, and messages land in a designated channel. Org members reply through their own personal Gardens email or their own email client.

---

## Architecture

```
INBOUND (users + orgs)
External MTA
    │  SMTP  (Cloudflare Email Routing: TLS, SPF/DKIM validated)
    ▼
Cloudflare Email Routing  →  catch-all rule  →  gardens-relay Worker
    │  email(message, env, ctx)
    │  PostalMime.parse
    │  resolvePkarr(localPart) → verify email=1
    ▼
POST sync worker /deliver  →  TopicDO(inbox_topic or room_topic)
    │  WebSocket push
    ▼
Gardens app  →  ingest_op()  →  projector  →  InboxScreen / channel

OUTBOUND (users only)
InboxScreen FAB / Reply  →  ComposeEmailSheet
    │  core.prepare_outbound_email()
    │  signs payload with user Ed25519 private key
    ▼
POST relay /send-email  { signed_payload, signature }
    │  verify Ed25519 sig against from_z32
    │  timestamp freshness check (< 5 min)
    │  KV rate limit (50 emails/hour per z32)
    ▼
env.EMAIL.send(new EmailMessage(from, to, mime))
    │  Cloudflare delivers, SPF/DKIM auto-configured
    ▼
External recipient's inbox
```

---

## How It Works

### 1. MX Record in Pkarr

When a user or org opts in, Gardens publishes an `MX` record alongside the existing TXT records in their pkarr DHT packet:

```
MX 10 route1.mx.cloudflare.net
```

The pkarr TXT record also gains an `email=1` flag:

```
v=gardens1 t=user n=Alice a=<blobId> email=1
```

For orgs:
```
v=gardens1 t=org n=Acme email=1
```

### 2. Inbound: Cloudflare Email Routing

Cloudflare Email Routing (free, no container required) handles inbound SMTP. A catch-all rule on `gardens-relay.stereos.workers.dev` forwards every `*@gardens-relay.stereos.workers.dev` message to the relay Worker's `email` handler.

**Dashboard setup (one-time):**
1. Cloudflare dashboard → Email Routing → Enable for the `stereos.workers.dev` zone
2. Add catch-all rule: Destination = Worker → `gardens-relay`
3. Cloudflare manages MX records for the zone automatically

**Email Worker handler** (`relay/src/index.ts`):

```typescript
import PostalMime from 'postal-mime';

async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
  const localPart = message.to.split('@')[0];

  const record = await resolvePkarr(localPart);
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

  const topic = record.type === 'org'
    ? await resolveOrgDeliveryTopic(localPart)   // delivers to #email or #general room
    : deriveInboxTopic(localPart);                // delivers to user's personal inbox

  await env.SYNC_WORKER.fetch('https://sync/deliver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic_hex: topic, op_base64: encodeOp(op) }),
  });
},
```

### 3. Outbound: Cloudflare Email Routing Send Binding

**`relay/wrangler.toml` addition:**
```toml
[[send_email]]
name = "EMAIL"
# no destination_address restriction — users send to any external address
```

**Outbound endpoint** (`POST /send-email`):

```typescript
app.post('/send-email', async (c) => {
  const { signed_payload, signature } = await c.req.json();
  const payload = JSON.parse(signed_payload);

  // Freshness check — prevents replay attacks
  if (Date.now() - payload.timestamp > 5 * 60 * 1000) {
    return c.json({ error: 'expired' }, 400);
  }

  // Verify Ed25519 signature: decode z32 → pubkey, verify sig over signed_payload bytes
  const pubkey = z32Decode(payload.from_z32);
  const valid = await verifyEd25519(
    pubkey,
    new TextEncoder().encode(signed_payload),
    base64ToBytes(signature),
  );
  if (!valid) return c.json({ error: 'invalid signature' }, 403);

  // Rate limit: 50 emails/hour per from_z32
  const rateKey = `email_rate:${payload.from_z32}`;
  const count = Number(await c.env.KV.get(rateKey) ?? 0);
  if (count >= 50) return c.json({ error: 'rate_limit' }, 429);
  await c.env.KV.put(rateKey, String(count + 1), { expirationTtl: 3600 });

  // Build MIME and send
  const mime = buildMime(payload);
  const from = `${payload.from_z32}@gardens-relay.stereos.workers.dev`;
  await c.env.EMAIL.send(new EmailMessage(from, payload.to, mime));

  return c.json({ ok: true });
});
```

**`relay/src/mime.ts`** — builds RFC 2822 MIME using `mimetext`:

```typescript
import { createMimeMessage } from 'mimetext';

export function buildMime(payload: OutboundEmailPayload): ReadableStream {
  const msg = createMimeMessage();
  msg.setSender(payload.from_z32 + '@gardens-relay.stereos.workers.dev');
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

**New relay packages:**
```json
"postal-mime": "^2.2.0",
"mimetext": "^3.0.0"
```

### 4. Signed Payload Format

Core builds and signs this before POSTing to `/send-email`:

```json
{
  "from_z32": "abc123...",
  "to": "alice@example.com",
  "subject": "Hello",
  "body_text": "...",
  "body_html": null,
  "reply_to_message_id": null,
  "timestamp": 1709734800000
}
```

The relay verifies the Ed25519 signature over the raw JSON string of this object, using the public key decoded from `from_z32`.

### 5. Inbox Topic

Each user has a deterministic inbox topic derived from their public key:

```
inbox_topic_hex = blake3(pubkey_bytes || "gardens:inbox:v1").to_hex()
```

The app subscribes to this topic on startup via the existing `useSyncStore` WebSocket mechanism. `opTick` increments on every received op, triggering `useInboxStore.fetchEmails()`.

### 6. Email Op Type

```rust
pub const EMAIL: &str = "email";

pub struct EmailOp {
    pub op_type: String,           // "receive_email"
    pub from: String,              // sender address
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub message_id: String,        // SMTP Message-ID (dedup key)
    pub received_at: i64,
}
```

### 7. Org Delivery Channel Logic

When an inbound email targets an org z32:

1. Look for a room named `email` in the org — deliver there.
2. Fall back to the room named `general`.
3. Fall back to the first room in the org.

Email renders inline as a card in the channel with `contentType: 'email'`.

---

## Core Changes

**`core/src/gardens_core.udl`:**
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

**`core/src/lib.rs`:**
```rust
pub fn prepare_outbound_email(
    to: String,
    subject: String,
    body_text: String,
    body_html: Option<String>,
    reply_to_message_id: Option<String>,
) -> Result<String, CoreError> {
    let keypair = state.auth.keypair()?;
    let from_z32 = keypair.public_key().to_z32();
    let timestamp = now_millis();

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
    let signature = keypair.sign(payload_str.as_bytes());

    Ok(serde_json::json!({
        "signed_payload": payload_str,
        "signature": BASE64.encode(signature.to_bytes()),
    }).to_string())
}
```

**`core/src/pkarr_publish.rs`** — emit MX record when `email=true`:
```rust
let txt = format!("v=gardens1 t=user n={} a={} email={}",
    name, avatar_blob_id, if email { "1" } else { "0" });

if email {
    packet.answers.push(ResourceRecord {
        name: Name::new("@").unwrap(),
        class: CLASS::IN,
        ttl: 300,
        rdata: RData::MX(MX {
            preference: 10,
            exchange: Name::new("route1.mx.cloudflare.net").unwrap(),
        }),
    });
}
```

---

## App Changes

### Store: `app/src/stores/useInboxStore.ts`

```typescript
interface EmailMessage {
  messageId: string;
  from: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: number;
  isRead: boolean;
}

interface InboxState {
  emails: EmailMessage[];
  unreadCount: number;
  fetchEmails(): Promise<void>;
  markRead(messageId: string): Promise<void>;
  sendEmail(params: {
    to: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    replyToMessageId?: string;
  }): Promise<void>;
}
```

- `fetchEmails` reads EmailOps from the projector (same `listMessages` FFI, `contentType: 'email'`)
- `sendEmail` calls `prepareOutboundEmail` → `POST relay/send-email` → optimistic local append on success
- `markRead` stores a local read receipt op on the inbox topic (syncs read state across devices)
- Unread count badge on the Inbox nav tab

### FFI: `app/src/ffi/gardensCore.ts`

```typescript
export async function prepareOutboundEmail(params: {
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  replyToMessageId?: string;
}): Promise<{ signedPayload: string; signature: string }> {
  const raw = await native.prepare_outbound_email(
    params.to, params.subject, params.bodyText,
    params.bodyHtml ?? null, params.replyToMessageId ?? null,
  );
  return JSON.parse(raw);
}
```

### New Screens and Sheets

**`app/src/screens/InboxScreen.tsx`**
```
┌─────────────────────────────────────────────────────┐
│  Inbox                                    [●] 3     │
├─────────────────────────────────────────────────────┤
│  ●  alice@example.com             2 hours ago        │
│     Re: Partnership inquiry                          │
│     Hi, thanks for reaching out. We'd love to...    │
├─────────────────────────────────────────────────────┤
│     noreply@github.com            Yesterday          │
│     [gardens/delta] PR #42 merged                    │
│     Your pull request was merged into main...        │
├─────────────────────────────────────────────────────┤
│                                           [+] FAB   │
└─────────────────────────────────────────────────────┘
```
- Subscribes to `deriveInboxTopic(myZ32)` via `useSyncStore` on mount
- `opTick` triggers `fetchEmails()`
- Unread rows: filled dot indicator + bold subject
- Tap row → `EmailDetailSheet`
- FAB → `ComposeEmailSheet`

**`app/src/sheets/EmailDetailSheet.tsx`**
```
┌─────────────────────────────────────────────────────┐
│  Re: Partnership inquiry                             │
│  alice@example.com  ·  2 hours ago                   │
├─────────────────────────────────────────────────────┤
│  Hi, thanks for reaching out. We'd love to discuss  │
│  the opportunity further...                          │
│                                                      │
│  [Show HTML version]                                 │
│                                        [Reply]       │
└─────────────────────────────────────────────────────┘
```
- "Reply" opens `ComposeEmailSheet` pre-filled with `to`, `Re: subject`, `replyToMessageId`
- "Show HTML version" renders `body_html` in a sandboxed `WebView`

**`app/src/sheets/ComposeEmailSheet.tsx`**
```
┌─────────────────────────────────────────────────────┐
│  New Email                                   [Send] │
├─────────────────────────────────────────────────────┤
│  From:    <z32>@gardens-relay.stereos.workers.dev   │
│  To:      alice@example.com                         │
│  Subject: Re: Partnership inquiry                    │
├─────────────────────────────────────────────────────┤
│  Thanks for the note! ...                            │
└─────────────────────────────────────────────────────┘
```
- From address is non-editable
- Plain text body only (HTML compose is future scope)
- Send: loading state → dismiss on success → error toast on failure

### Updated Screens

**`app/src/screens/UserSettingsScreen.tsx`** — Email section:
```
┌─────────────────────────────────────────────────────┐
│  Email                                               │
│                                                      │
│  Your address:                                       │
│  <z32>@gardens-relay.stereos.workers.dev  [Copy]    │
│                                                      │
│  [●] Send & receive email          (toggle)          │
│                                                      │
│  Anyone with your address can email you. You can    │
│  also send email to external addresses from Gardens. │
│                                                      │
│  Custom domain                                       │
│  MX    @    route1.mx.cloudflare.net (priority 10)  │
└─────────────────────────────────────────────────────┘
```

Toggle on: republishes pkarr with `email=1` + MX record. Enables both inbound and outbound.
Toggle off: republishes pkarr without `email=1`. Relay rejects inbound; outbound endpoint rejects requests from this z32.

**`app/src/screens/OrgSettingsScreen.tsx`** — Email section (receive-only, unchanged from prior design):
- Toggle to enable inbound only
- Channel picker (#email, #general, or first room)
- Org address + custom domain DNS instructions

**`app/src/components/ChannelMessage.tsx`** — email card render for org inbound:
```
┌─ from: alice@example.com ─────────────────────────┐
│  Re: Partnership inquiry                            │
│  Hi, thanks for reaching out...         [Expand]   │
└─────────────────────────────────────────────────────┘
```

---

## Implementation Touch Points

| File | Change |
|---|---|
| `relay/wrangler.toml` | Add `[[send_email]]` binding |
| `relay/src/index.ts` | Add `email` handler export, `POST /send-email` endpoint |
| `relay/src/mime.ts` | New file — MIME builder using `mimetext` |
| `relay/package.json` | Add `postal-mime`, `mimetext` |
| `core/src/gardens_core.udl` | Add `prepare_outbound_email`, `email: boolean` to `Profile` |
| `core/src/lib.rs` | Implement `prepare_outbound_email` |
| `core/src/pkarr_publish.rs` | Emit MX record + `email=1` TXT flag when `email=true` |
| `app/src/ffi/gardensCore.ts` | Add `prepareOutboundEmail` wrapper |
| `app/src/stores/useInboxStore.ts` | New store |
| `app/src/screens/InboxScreen.tsx` | New screen |
| `app/src/sheets/ComposeEmailSheet.tsx` | New sheet |
| `app/src/sheets/EmailDetailSheet.tsx` | New sheet |
| `app/src/screens/UserSettingsScreen.tsx` | Update Email section (send + receive toggle) |
| `app/src/screens/OrgSettingsScreen.tsx` | Add Email section (receive-only toggle + channel picker) |
| `app/src/components/ChannelMessage.tsx` | Add `email` content type render |
| `app/src/navigation/RootNavigator.tsx` | Add Inbox tab |

---

## Security Notes

- **Ed25519 payload signing** — the relay verifies every outbound send request is signed by the private key corresponding to the claimed `from_z32`. Impersonation is cryptographically impossible without the private key.
- **Timestamp freshness** — the relay rejects payloads older than 5 minutes, preventing replay attacks.
- **Rate limiting** — 50 outbound emails/hour per z32 via Cloudflare KV, prevents abuse of the relay as a spam source.
- **Opt-in only** — `email=1` must be present in pkarr for inbound. Identities without it receive a `setReject` at the Email Routing layer before any op is created. The relay also checks `email=1` before processing outbound sends.
- **SPF/DKIM handled by Cloudflare** — Email Routing validates SPF/DKIM on inbound before the Worker is invoked. For outbound, the `send_email` binding auto-configures SPF/DKIM/DMARC for the `stereos.workers.dev` zone.
- **Dedup by Message-ID** — the `message_id` field in `EmailOp` lets the projector silently drop duplicate deliveries (retry storms from external MTAs).
- **HTML sandboxing** — `body_html` is only rendered on explicit tap, inside a sandboxed `WebView`, never inline.

---

## Decisions

### User vs Org Scope
Users get full bidirectional email. Orgs are receive-only — external parties contact the org via email, messages land in a designated channel. Org members respond through their own personal Gardens email or their own email client. This keeps org email simple and avoids the complexity of member authorization for outbound.

### Signing Approach
App signs the outbound payload with the user's Ed25519 private key (same key backing the z32 identity). Relay verifies stateless — no session management, no capability tokens. Consistent with how p2panda ops are already signed throughout the system.

### Attachments
Small attachments (< 256 KB) are base64-encoded directly into the `EmailOp` body. Larger attachments are stored as blobs — encrypted private blobs for user emails. The `EmailOp` carries a `blobId` reference; the app fetches lazily on tap.

### Outbound Infrastructure
Cloudflare Email Routing `send_email` Worker binding handles outbound. SPF/DKIM/DMARC are auto-configured by Cloudflare for the zone. No external API keys, no third-party email providers.

### HTML Compose
Plain text only for compose in v1. HTML compose (rich text editor → HTML body) is future scope — the `body_html` field is already in `EmailOp` and `OutboundEmailPayload` so it can be added without schema changes.

### Reply Routing
Tap "Reply" on an inbound email → `ComposeEmailSheet` pre-filled with sender address and `Re:` subject. The `In-Reply-To` and `References` MIME headers are set from `reply_to_message_id` so external email clients thread correctly.

### Spam Filtering
SPF/DKIM validation by Cloudflare Email Routing is the baseline — runs before the Email Worker is invoked. Beyond that, Cloudflare's email security tooling (category-based filtering, sender reputation) handles broad protection. Users can block individual senders from within the app (stored as a `block_sender` op on their inbox topic).

### MX TTL Lag
Non-issue in practice. The relay checks pkarr live on every inbound request, so delivery stops immediately when `email=1` is removed regardless of what external MTAs have cached. TTL lag only affects whether external MTAs attempt delivery, not whether Gardens accepts it.

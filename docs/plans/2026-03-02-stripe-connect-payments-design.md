# Gardens — Stripe Connect Community Paywall Design

**Date:** 2026-03-02  
**Status:** Design Approved  
**Author:** Gardens Core Team

---

## Overview

Enable community owners to monetize access to their organizations using **Stripe Connect Express**. Members pay to join communities, with funds flowing directly to the community owner's Stripe account. Gardens takes a platform fee (configurable, suggested: 5-10%).

**Key Principles:**
- **Privacy-Preserving:** Users pay via Stripe (KYC only with Stripe), not linked to their Gardens identity
- **Direct Payouts:** Community owners receive funds directly to their bank account
- **No Custody:** Gardens never holds funds; all transactions are peer-to-peer via Stripe
- **Anonymous Joins:** Payment identity is separate from Gardens cryptographic identity

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Gardens Mobile App                               │
│                                                                          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────┐  │
│  │   Member    │───▶│  Join Org   │───▶│  Check Payment Status       │  │
│  │  (wants to  │    │   Screen    │    │  (API: /check-payment)      │  │
│  │   join org) │    │             │    │                             │  │
│  └─────────────┘    └─────────────┘    └─────────────────────────────┘  │
│                                                 │                        │
│                                                 ▼                        │
│                                        ┌─────────────────────────────┐  │
│                                        │  Already Paid?              │  │
│                                        │  ├─ Yes → Join immediately  │  │
│                                        │  └─ No  → Show payment flow │  │
│                                        └─────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Payment Flow (if not paid):                                       │  │
│  │                                                                    │  │
│  │  1. Call /create-checkout-session?owner_key=Y&user_key=Z          │  │
│  │  2. Receive Stripe Checkout URL                                    │  │
│  │  3. Open in-app browser → Stripe Checkout                         │  │
│  │  4. User pays with card/Apple Pay/Google Pay                      │  │
│  │  5. Stripe webhook → Gateway records payment                       │  │
│  │  6. User returns to app → Poll /check-payment                     │  │
│  │  7. Payment confirmed → Issue invite token → Join                 │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS / WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Gardens Gateway (Node.js)                          │
│                    (NEW: Payment service layer)                          │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Database: SQLite (payments table)                                 │  │
│  │                                                                    │  │
│  │  CREATE TABLE payments (                                           │  │
│  │      id              INTEGER PRIMARY KEY,                          │  │
│  │      payer_key       TEXT NOT NULL,      -- User's Gardens pubkey   │  │
│  │      payee_key       TEXT NOT NULL,      -- Owner's Gardens pubkey  │  │
│  │      org_id          TEXT NOT NULL,                              │  │
│  │      stripe_account  TEXT NOT NULL,      -- Connected acct ID     │  │
│  │      stripe_session  TEXT,               -- Checkout session ID   │  │
│  │      amount_cents    INTEGER NOT NULL,   -- e.g., 1000 = $10.00   │  │
│  │      platform_fee    INTEGER NOT NULL,   -- e.g., 50 = $0.50      │  │
│  │      currency        TEXT DEFAULT 'usd',                         │  │
│  │      status          TEXT NOT NULL,      -- pending | paid | failed│  │
│  │      paid_at         INTEGER,              -- Unix timestamp      │  │
│  │      invite_token    TEXT,                 -- Issued on payment   │  │
│  │      created_at      INTEGER NOT NULL                            │  │
│  │  );                                                                │  │
│  │                                                                    │  │
│  │  CREATE INDEX idx_payments_payer ON payments(payer_key, payee_key)│  │
│  │  CREATE INDEX idx_payments_status ON payments(status)             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Endpoints:                                                              │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌──────────────────┐     │
│  │ GET /price      │  │ POST /pay           │  │ GET /check-pay   │     │
│  │ Query: owner_key│  │ Body: owner_key,    │  │ Query: owner_key│     │
│  │        user_key │  │       user_key      │  │        user_key │     │
│  │ Response: price │  │ Response: stripe_url│  │ Response: status│     │
│  └─────────────────┘  └─────────────────────┘  └──────────────────┘     │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ POST /webhook/stripe                                               │  │
│  │ - Receives Stripe checkout.session.completed                       │  │
│  │ - Records payment as paid                                          │  │
│  │ - Generates invite token                                           │  │
│  │ - Stores token in payments table                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Stripe API
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              Stripe Platform                             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ Community Owner (Connected Account - Express)                    │    │
│  │                                                                  │    │
│  │  - Onboards via Stripe Express (KYC with Stripe, not Gardens)     │    │
│  │  - Receives 90-95% of payment directly to bank                  │    │
│  │  - Stripe handles tax forms, compliance                         │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Platform Fee: 5-10% goes to Gardens operator                              │
│  Payout: Immediate to connected account (Stripe handles timing)          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Owner Onboarding Flow

Community owners must connect their Stripe account before they can set a price:

```
Owner taps "Enable Paid Access" in Org Settings
         │
         ▼
┌────────────────────────────┐
│ Gateway: POST /connect     │
│ Creates Stripe account link │
└────────────────────────────┘
         │
         ▼
Stripe Onboarding (Express)
- Owner provides bank, tax info to Stripe
- Stripe handles KYC/AML
         │
         ▼
Owner redirected back to app
         │
         ▼
Gateway stores: stripe_account_id + org_id mapping

Owner can now set price (e.g., $5/month or $50 one-time)
```

---

## Member Join Flow

```
User wants to join Org (owner_key = Y, user_key = Z)
         │
         ▼
┌────────────────────────────────────────┐
│ App calls:                             │
│ GET /check-payment?owner=Y&user=Z     │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ If NOT paid:                           │
│   Call POST /pay?owner=Y              │
│   Returns: { stripe_url, session_id }  │
│                                        │
│   Open stripe_url in WebView           │
│   User completes payment               │
│   Stripe redirects to app:// callback  │
│                                        │
│   App polls /check-payment until paid  │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ Once paid:                             │
│   Gateway returns: {                   │
│     paid: true,                        │
│     invite_token: "xyz...",            │
│     expires_at: 1234567890             │
│   }                                    │
│                                        │
│   App uses invite_token to join org    │
└────────────────────────────────────────┘
```

---

## API Endpoints (Gateway)

### 1. Get Price
```http
GET /price?owner_key=<owner_pubkey_hex>

Response:
{
  "enabled": true,
  "amount_cents": 1000,      // $10.00
  "currency": "usd",
  "interval": "month",        // or "one_time"
  "description": "Access to Community Name"
}
```

### 2. Create Checkout Session
```http
POST /pay
Content-Type: application/json

{
  "owner_key": "<64-hex-chars>",
  "user_key": "<64-hex-chars>",
  "success_url": "gardens://payment/success",
  "cancel_url": "gardens://payment/cancel"
}

Response:
{
  "stripe_url": "https://checkout.stripe.com/pay/cs_test_...",
  "session_id": "cs_test_..."
}
```

### 3. Check Payment Status
```http
GET /check-payment?owner_key=<hex>&user_key=<hex>

Response (not paid):
{
  "paid": false,
  "stripe_url": "https://checkout.stripe.com/pay/cs_test_..."  // if session exists
}

Response (paid):
{
  "paid": true,
  "invite_token": "base64-signed-token",
  "token_expires_at": 1234567890
}
```

### 4. Stripe Webhook
```http
POST /webhook/stripe
Stripe-Signature: <signature>

// Handles: checkout.session.completed
// Records payment, generates invite token
```

### 5. Owner Onboarding
```http
POST /connect/onboard
{
  "owner_key": "<hex>",
  "refresh_url": "gardens://stripe/refresh",
  "return_url": "gardens://stripe/return"
}

Response:
{
  "url": "https://connect.stripe.com/setup/s/acct_..."
}

// After onboarding, owner can set price:
POST /connect/set-price
{
  "owner_key": "<hex>",
  "amount_cents": 1000,
  "interval": "month"  // or "one_time"
}
```

---

## Invite Token Format

When payment is confirmed, the gateway generates a signed invite token:

```rust
struct PaidInviteToken {
    org_id: String,
    owner_key: String,        // Verified: matches paid payee
    member_key: String,       // Verified: matches paid payer
    amount_paid_cents: u32,
    paid_at: i64,             // Unix timestamp
    expires_at: i64,          // Token expiry (e.g., 24h)
    nonce: [u8; 16],          // Prevent replay
    gateway_sig: [u8; 64],    // Gateway Ed25519 signature
}
```

Token is base64-encoded and passed to the app. The app then calls the existing `verify_and_join` flow with this token.

---

## Privacy & Security

### Privacy Guarantees

| Identity | Stripe Knows | Gateway Knows | Org Owner Knows | Other Members Know |
|----------|-------------|---------------|-----------------|-------------------|
| Payment card | Yes | No | No | No |
| Email (optional) | Yes* | No | No | No |
| Gardens public key | No | Yes | No | No |
| Username | No | No | No | Yes (after join) |

*Stripe Express can be configured to not collect email

### Security Measures

1. **Webhook Verification:** All Stripe webhooks verified with `stripe.webhooks.constructEvent()`
2. **Replay Protection:** Invite tokens include nonce and short expiry (24h)
3. **Signature Verification:** Tokens signed with Gateway's Ed25519 key
4. **No Refund Abuse:** Payments final; disputes handled via Stripe dashboard
5. **Rate Limiting:** `/pay` endpoint rate-limited per user_key

---

## Gateway Deployment

**Service:** Node.js/TypeScript (Cloudflare Workers or VPS)  
**Database:** SQLite (via `better-sqlite3` or `libsql` for edge)  
**Secrets:**
- `STRIPE_SECRET_KEY` (test or live)
- `STRIPE_WEBHOOK_SECRET`
- `GATEWAY_SIGNING_KEY` (Ed25519 seed, 64 hex chars)

**Environment:**
- Test mode: `STRIPE_SECRET_KEY=sk_test_...`
- Live mode: `STRIPE_SECRET_KEY=sk_live_...`

---

## Pricing Models

| Model | Use Case | Implementation |
|-------|----------|----------------|
| **One-time** | Lifetime access | `interval: "one_time"` |
| **Monthly** | Subscription community | Stripe Subscription + `interval: "month"` |
| **Tiered** | Different levels (Basic/Premium) | Multiple products per org |

---

## Alternatives Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Stripe Connect** (chosen) | Direct payouts, Stripe handles compliance, mainstream UX | Requires KYC for owners | ✅ Approved |
| Cashu eCash | No KYC, fully anonymous | Requires Lightning wallet, harder UX, custody issues | Future option |
| Custodial wallet | Simple | Regulatory risk, requires money transmitter license | ❌ Rejected |
| Crypto (on-chain) | Permissionless | Gas fees, UX friction, volatility | ❌ Rejected |

---

## Future Enhancements

1. **Cashu Support:** Add eCash as alternative payment method for privacy-maximal users
2. **Recurring Subscriptions:** Auto-renew with Stripe Subscriptions
3. **Refunds:** Owner-initiated refunds via Gateway API
4. **Analytics:** Owner dashboard for revenue, churn
5. **Discounts:** Promo codes via Stripe Coupons

---

## Files to Create

| File | Description |
|------|-------------|
| `gateway/src/index.ts` | Express/Fastify server with endpoints |
| `gateway/src/db.ts` | SQLite schema and queries |
| `gateway/src/stripe.ts` | Stripe SDK integration |
| `gateway/src/tokens.ts` | Invite token signing/verification |
| `app/src/stores/usePaymentsStore.ts` | Payment state management |
| `app/src/screens/PaymentScreen.tsx` | Checkout WebView wrapper |
| `app/src/screens/OrgSettingsScreen.tsx` | Owner onboarding & price setting |

---

## Open Questions

1. **Platform fee %:** Start with 5% or 10%?
2. **Minimum price:** $1? $5?
3. **Subscription grace period:** 7 days before removal?
4. **Dispute handling:** Auto-revoke access on chargeback?

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | Use Stripe Connect Express | Best balance of UX, compliance, and direct payouts |
| 2026-03-02 | Gateway signs invite tokens | Trust-minimized: Core verifies signature |
| 2026-03-02 | SQLite for payments DB | Sufficient scale, easy backup, no external deps |

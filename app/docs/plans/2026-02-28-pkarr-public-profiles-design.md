# Public Profiles & Community Discovery via pkarr

**Date:** 2026-02-28
**Status:** Approved

---

## Overview

Users and org admins can opt in to a public profile. When they do, their
profile/org data is published as signed DNS TXT records to the mainline
BitTorrent DHT via **pkarr** — already compiled into the binary as a transitive
iroh dependency. Anyone on the internet can resolve the record by public key.
A custom domain can be linked via a single DNS TXT record.

"Discover Communities" is implemented as **link/QR-based invite**, not a
browse/search page. This is cleaner UX for a decentralized app and matches how
Discord and Signal work.

---

## UX Flow

### User public profile

1. User opens **User Settings → Privacy → Public Profile** toggle (default OFF).
2. On toggle ON:
   - Profile is published to pkarr DHT immediately (fire-and-forget).
   - Settings sheet expands to show a **Public Identity Card**:
     - Their pkarr URL (`pk:yj4bqhvahk8dge...`) — tap to copy
     - Truncated public key hex — tap to copy full key
     - QR code of the pkarr URL (scannable by any Delta app)
     - **DNS Configuration** expandable section (see below)
3. On toggle OFF: publish an empty/tombstone record. DHT entry expires after
   ~2 hrs naturally. No active revocation.

### Org public profile (admin-only)

Same flow inside **Server Settings → General → Visibility** toggle. Admins see
the same Public Identity Card. Non-admins never see the toggle.

A **"Share Community"** button appears when public, generating a shareable
deep link: `delta://pk:yj4bqhvahk8dge...`

### Discover Communities (link/QR invite)

- Admin shares their org's pkarr deep link (copy, share sheet, or QR).
- Recipient taps the link or scans QR → app opens a **Community Preview Sheet**
  showing name, description, member count (from pkarr record).
- User taps **Request to Join** → sends a join request op to the org's topic.
- This replaces the current stub "Search & Discover" screen entirely.

### DNS configuration info

Displayed after toggling public. Non-technical users can ignore it; power users
can link a custom domain.

```
Your public page
────────────────
pk:yj4bqhvahk8dge7r3s9q...          [Copy]  [QR]

To use a custom domain (optional)
──────────────────────────────────
Add one TXT record to your DNS:

  Host:   _delta
  Value:  pk:yj4bqhvahk8dge7r3s9q...

Delta-enabled apps can then resolve you
at yourdomain.com
```

---

## pkarr Record Format

DNS TXT records published under `_delta` label.

**User profile:**
```
_delta TXT "v=delta1;t=user;u=alice;b=Hello world;a=<avatar_blob_id>"
```

**Org profile:**
```
_delta TXT "v=delta1;t=org;n=Rustaceans;d=A community for Rust devs;a=<avatar_blob_id>"
```

Fields kept intentionally small to stay well within the ~1 KB DNS packet limit.
Avatar is stored as a blob ID hash — resolution fetches it via p2panda blobs.

---

## Implementation Plan

### Step 1 — Rust core: `pkarr.rs` module

- Add `pkarr = { version = "5", features = ["async"] }` to `Cargo.toml`.
- Create `core/src/pkarr_publish.rs`:
  - `publish_profile(private_key, username, bio, avatar_blob_id, is_public)`
  - `publish_org(private_key, org_id, name, description, avatar_blob_id, is_public)`
  - `get_pkarr_url(private_key) -> String` — returns `pk:<z32-pubkey>`
  - `start_republish_loop(read_pool)` — tokio background task, republishes every
    50 min for all public profiles/orgs found in DB.
- Key bridging: `pkarr::Keypair::from_secret_key(private_key.as_bytes())` — same
  Ed25519 key, zero conversion.

### Step 2 — Rust core: add `is_public` to Profile

- Add `is_public BOOLEAN NOT NULL DEFAULT 0` column to `profiles` table in DB
  migration.
- Add `is_public: bool` to `ProfileRow`, `ProfileOp`, `Profile` UDL dictionary.
- Update `create_or_update_profile` UDL function to accept `is_public: bool`.
- Hook: after storing the profile op, if `is_public = true`, call
  `pkarr_publish::publish_profile(...)` fire-and-forget.

### Step 3 — Rust core: hook org publishing

- `OrgRow.is_public` already exists. After `create_org` / `update_org`, if
  `is_public = true`, call `pkarr_publish::publish_org(...)` fire-and-forget.
- Add `get_pkarr_url(public_key_hex: String) -> String` to UDL and `lib.rs`.

### Step 4 — Rust core: start republish loop

- In `store::bootstrap()`, after network init, spawn
  `pkarr_publish::start_republish_loop(read_pool)`.

### Step 5 — React Native: `PublicIdentityCard` component

New component `src/components/PublicIdentityCard.tsx`:
- Props: `{ pkarrUrl, publicKeyHex, label }`
- Shows: pkarr URL (copyable), truncated hex key (tap to copy full), QR code
  (`react-native-qrcode-svg` already installed), "Share" button.
- Expandable "DNS Configuration" section with copy-ready TXT record value.
- Styled dark, matches existing design system.

### Step 6 — React Native: `UserSettingsScreen`

- Replace "Visibility" `SettingsRow` stub with a real `Switch` + label row.
- Below the switch (when ON): render `<PublicIdentityCard />`.
- Call `deltaCore.createOrUpdateProfile({ ..., isPublic: true/false })` on
  toggle.
- Fetch current profile on mount to initialise switch state.

### Step 7 — React Native: `OrgSettingsScreen`

- Replace "Visibility" `SettingsRow` stub with `Switch` + label row.
- Below switch (when ON): render `<PublicIdentityCard />` + **"Share Community"**
  button that opens the system share sheet with the deep link.
- Call `deltaCore.updateOrg({ orgId, isPublic: true/false })` on toggle.

### Step 8 — React Native: deep link handler + Community Preview Sheet

- Register deep link scheme `delta://pk:<z32>` in app config.
- New `src/sheets/CommunityPreviewSheet.tsx`:
  - On open: call `deltaCore.resolvePkarrOrg(z32Key)` which calls
    `pkarr::Client::resolve()` in Rust and returns `{ name, description, publicKey }`.
  - Shows org name, description, public key, QR.
  - "Request to Join" button (wires into existing membership ops).
- Update `RootNavigator` to handle the deep link and open the sheet.

---

## What's Out of Scope

- **Browse/search communities** — no search-by-name in DHT; link/QR sharing
  covers the use case without requiring a central index.
- **Web public pages** — a gateway/web renderer (e.g. `pk:key.pkarr.org`) is a
  separate server-side project, not part of the mobile app.
- **Active revocation** — toggling off stops republishing; the DHT record
  expires naturally in ~2 hrs.

---

## Packages Required

| Package | Status |
|---|---|
| `pkarr` (Rust) | Add to `Cargo.toml` |
| `react-native-qrcode-svg` | Already installed |
| `react-native-svg` | Already installed |

No new native modules required on the React Native side.

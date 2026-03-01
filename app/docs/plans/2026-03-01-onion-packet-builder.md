# Onion Packet Builder — Rust Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a general-purpose onion routing packet builder and peeler in the Rust core, exposed via UniFFI to React Native, so any delta protocol message can be layered-encrypted through an arbitrary chain of hops (Cloudflare Workers or iroh relay nodes) using each device's existing Ed25519 keypair as its routing identity.

**Architecture:** Each onion layer is a binary envelope: `VERSION[1] | EPK[32] | NONCE[24] | CIPHERTEXT[N]`. The plaintext payload encodes either a "forward" instruction (next hop URL + inner packet) or a "deliver" instruction (iroh node ID + raw delta message bytes). Layers are built inside-out: innermost wraps the deliver instruction to the final hop, each outer layer wraps a forward instruction to the preceding hop. The sender's identity is never included — each layer uses a fresh ephemeral X25519 keypair, giving sender anonymity identical to Sphinx. Crypto is ECDH(ephemeral, hop_x25519) → HKDF-SHA256 → XChaCha20-Poly1305, reusing the exact same algorithm as `sealed_sender.rs`.

**Tech Stack:** Rust, `x25519-dalek`, `chacha20poly1305`, `hkdf`, `sha2` (all already in Cargo.toml), UniFFI 0.31 for FFI, TypeScript wrapper in `deltaCore.ts`.

---

## Background: How the Crypto Already Works

`sealed_sender.rs` already implements the exact crypto primitive we need:

```
ed25519_seed_to_x25519  →  SHA-512(seed)[0..32] + RFC7748 clamp
ed25519_pubkey_to_x25519 → CompressedEdwardsY.to_montgomery()
derive_aead_key          → HKDF-SHA256(shared_secret, ephemeral_pk, info)
```

These helpers are currently private to `sealed_sender.rs`. Task 1 moves them to a shared `crypto.rs` so both modules use them without duplication.

---

## Wire Format Reference

### Envelope (every hop sees this)
```
[0]     VERSION = 0x02  (0x01 is sealed-sender — distinct version avoids confusion)
[1..33] EPK     Sender's ephemeral X25519 public key (32 bytes)
[33..57] NONCE  XChaCha20-Poly1305 nonce (24 bytes)
[57..]  CIPHERTEXT  authenticated ciphertext
```
Min valid length: 1 + 32 + 24 + 16 (Poly1305 tag) = 73 bytes.

### Payload encoding (after decrypt)
```
[0]  TYPE
     0x01 = Forward
     0x02 = Deliver

TYPE=Forward:
  [1..3]   url_len: u16 big-endian
  [3..3+url_len]  next_hop_url: UTF-8 string
  [3+url_len..]   inner_packet: opaque bytes (next onion layer)

TYPE=Deliver:
  [1..33]  destination_node_id: 32 bytes (iroh node ID)
  [33..]   message: raw delta protocol bytes
```

No external encoding library needed — plain bytes.

### HKDF info string
`b"delta:onion:v1"` — distinct from `b"delta:sealed-sender:v1"`.

---

## Task 1: Extract Shared Crypto Helpers into `crypto.rs`

**Why first:** `onion.rs` needs the same three helpers as `sealed_sender.rs`. Move them now so Task 2 imports from one place, not two.

**Files:**
- Create: `core/src/crypto.rs`
- Modify: `core/src/sealed_sender.rs`
- Modify: `core/src/lib.rs` (add `pub mod crypto;`)

### Step 1: Create `core/src/crypto.rs` with the three helpers

```rust
//! Shared Curve25519 / AEAD helpers used by sealed_sender and onion modules.

use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey as X25519Public, StaticSecret};

/// Convert a 32-byte Ed25519 seed to an X25519 static secret.
/// Uses SHA-512/clamp derivation (RFC 7748 §5).
pub fn ed25519_seed_to_x25519(seed_bytes: &[u8; 32]) -> StaticSecret {
    use sha2::Digest;
    let hash = sha2::Sha512::digest(seed_bytes);
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash[..32]);
    key[0]  &= 248;
    key[31] &= 127;
    key[31] |= 64;
    StaticSecret::from(key)
}

/// Convert a 32-byte Ed25519 compressed public key to X25519 Montgomery form.
pub fn ed25519_pubkey_to_x25519(pubkey_bytes: &[u8; 32]) -> X25519Public {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*pubkey_bytes);
    let point = compressed
        .decompress()
        .unwrap_or(curve25519_dalek::EdwardsPoint::default());
    X25519Public::from(point.to_montgomery().to_bytes())
}

/// Derive a 32-byte AEAD key: HKDF-SHA256(shared_secret, salt=ephemeral_pk, info).
pub fn derive_aead_key(shared: &[u8; 32], ephemeral_pk: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(ephemeral_pk), shared);
    let mut key = [0u8; 32];
    hk.expand(info, &mut key).expect("HKDF output length is valid");
    key
}
```

### Step 2: Update `sealed_sender.rs` to import from `crypto`

Remove the three private functions and add at the top:

```rust
use crate::crypto::{derive_aead_key, ed25519_pubkey_to_x25519, ed25519_seed_to_x25519};
```

The call sites in `seal()` and `open()` need the `info` argument added:

```rust
// In seal():
let aead_key = derive_aead_key(shared.as_bytes(), ephemeral_public.as_bytes(), b"delta:sealed-sender:v1");

// In open():
let aead_key = derive_aead_key(shared.as_bytes(), &epk_bytes, b"delta:sealed-sender:v1");
```

### Step 3: Add `pub mod crypto;` to `lib.rs`

Add after the existing `pub mod` declarations at the top of `lib.rs`:

```rust
pub mod crypto;
```

### Step 4: Run existing sealed_sender tests to verify nothing broke

```bash
cd /Users/jdbohrman/delta/core
cargo test sealed_sender -- --nocapture
```

Expected: all 4 existing tests pass (`seal_and_open_roundtrip`, `wrong_recipient_key_fails`, `tampered_ciphertext_fails`, `is_sealed_detects_version_byte`).

### Step 5: Commit

```bash
cd /Users/jdbohrman/delta/core
git add src/crypto.rs src/sealed_sender.rs src/lib.rs
git commit -m "refactor: extract shared Curve25519/AEAD helpers into crypto.rs"
```

---

## Task 2: Core Onion Layer Crypto (`onion.rs`)

Implement single-layer encrypt and decrypt — the atomic building block. No route logic yet.

**Files:**
- Create: `core/src/onion.rs`
- Modify: `core/src/lib.rs` (add `pub mod onion;`)

### Step 1: Write the failing tests first

Add to `core/src/onion.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn random_keypair() -> ([u8; 32], [u8; 32]) {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let verifying = signing.verifying_key();
        (seed, *verifying.as_bytes())
    }

    #[test]
    fn encrypt_decrypt_forward_roundtrip() {
        let (seed, pubkey) = random_keypair();
        let inner = b"inner onion packet bytes";
        let payload = OnionPayload::Forward {
            next_hop_url: "https://relay.example.com/hop".to_string(),
            inner_packet: inner.to_vec(),
        };

        let envelope = encrypt_layer(&payload, &pubkey).unwrap();
        let recovered = decrypt_layer(&envelope, &seed).unwrap();

        match recovered {
            OnionPayload::Forward { next_hop_url, inner_packet } => {
                assert_eq!(next_hop_url, "https://relay.example.com/hop");
                assert_eq!(inner_packet, inner);
            }
            _ => panic!("expected Forward payload"),
        }
    }

    #[test]
    fn encrypt_decrypt_deliver_roundtrip() {
        let (seed, pubkey) = random_keypair();
        let node_id = [0xabu8; 32];
        let message = b"raw delta protocol bytes";
        let payload = OnionPayload::Deliver {
            destination_node_id: node_id,
            message: message.to_vec(),
        };

        let envelope = encrypt_layer(&payload, &pubkey).unwrap();
        let recovered = decrypt_layer(&envelope, &seed).unwrap();

        match recovered {
            OnionPayload::Deliver { destination_node_id, message: msg } => {
                assert_eq!(destination_node_id, node_id);
                assert_eq!(msg, message);
            }
            _ => panic!("expected Deliver payload"),
        }
    }

    #[test]
    fn wrong_key_fails_decryption() {
        let (_, pubkey) = random_keypair();
        let (wrong_seed, _) = random_keypair();
        let payload = OnionPayload::Forward {
            next_hop_url: "https://example.com".to_string(),
            inner_packet: vec![1, 2, 3],
        };
        let envelope = encrypt_layer(&payload, &pubkey).unwrap();
        assert!(decrypt_layer(&envelope, &wrong_seed).is_err());
    }

    #[test]
    fn tampered_envelope_fails() {
        let (seed, pubkey) = random_keypair();
        let payload = OnionPayload::Forward {
            next_hop_url: "https://example.com".to_string(),
            inner_packet: vec![1, 2, 3],
        };
        let mut envelope = encrypt_layer(&payload, &pubkey).unwrap();
        let last = envelope.len() - 1;
        envelope[last] ^= 0xff;
        assert!(decrypt_layer(&envelope, &seed).is_err());
    }

    #[test]
    fn envelope_too_short_fails() {
        let (seed, _) = random_keypair();
        assert!(decrypt_layer(b"short", &seed).is_err());
    }
}
```

### Step 2: Run tests to verify they fail

```bash
cd /Users/jdbohrman/delta/core
cargo test onion -- --nocapture 2>&1 | head -30
```

Expected: compile error (module doesn't exist yet). Add `pub mod onion;` to `lib.rs` first, then re-run — should fail with "unresolved imports".

### Step 3: Implement `onion.rs`

```rust
//! Onion routing packet builder and peeler.
//!
//! Each layer: VERSION[1] | EPK[32] | NONCE[24] | CIPHERTEXT[N]
//! Payload:    TYPE[1] | ...
//!   Forward:  url_len:u16 | url | inner_packet
//!   Deliver:  node_id[32] | message

use chacha20poly1305::{AeadCore, KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use rand::rngs::OsRng;
use thiserror::Error;
use x25519_dalek::{EphemeralSecret, PublicKey as X25519Public};

use crate::crypto::{derive_aead_key, ed25519_pubkey_to_x25519, ed25519_seed_to_x25519};

// ── Constants ─────────────────────────────────────────────────────────────────

const VERSION: u8      = 0x02;
const EPK_LEN: usize   = 32;
const NONCE_LEN: usize = 24;
const MIN_LEN: usize   = 1 + EPK_LEN + NONCE_LEN + 16;
const HKDF_INFO: &[u8] = b"delta:onion:v1";

// ── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum OnionError {
    #[error("route must have at least one hop")]
    EmptyRoute,
    #[error("envelope too short or malformed")]
    InvalidEnvelope,
    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u8),
    #[error("AEAD encryption failed")]
    Encrypt,
    #[error("AEAD decryption failed — wrong key or tampered")]
    Decrypt,
    #[error("invalid payload encoding")]
    InvalidPayload,
    #[error("invalid key bytes: {0}")]
    InvalidKey(String),
}

// ── Payload ───────────────────────────────────────────────────────────────────

/// Decoded onion payload after peeling one layer.
#[derive(Debug)]
pub enum OnionPayload {
    /// This hop should forward `inner_packet` to `next_hop_url`.
    Forward {
        next_hop_url: String,
        inner_packet: Vec<u8>,
    },
    /// This hop is the exit — deliver `message` to the iroh node `destination_node_id`.
    Deliver {
        destination_node_id: [u8; 32],
        message: Vec<u8>,
    },
}

// ── Payload encode / decode ───────────────────────────────────────────────────

fn encode_payload(p: &OnionPayload) -> Vec<u8> {
    match p {
        OnionPayload::Forward { next_hop_url, inner_packet } => {
            let url_bytes = next_hop_url.as_bytes();
            let url_len = url_bytes.len() as u16;
            let mut out = Vec::with_capacity(3 + url_bytes.len() + inner_packet.len());
            out.push(0x01);
            out.extend_from_slice(&url_len.to_be_bytes());
            out.extend_from_slice(url_bytes);
            out.extend_from_slice(inner_packet);
            out
        }
        OnionPayload::Deliver { destination_node_id, message } => {
            let mut out = Vec::with_capacity(1 + 32 + message.len());
            out.push(0x02);
            out.extend_from_slice(destination_node_id);
            out.extend_from_slice(message);
            out
        }
    }
}

fn decode_payload(bytes: &[u8]) -> Result<OnionPayload, OnionError> {
    if bytes.is_empty() {
        return Err(OnionError::InvalidPayload);
    }
    match bytes[0] {
        0x01 => {
            if bytes.len() < 3 {
                return Err(OnionError::InvalidPayload);
            }
            let url_len = u16::from_be_bytes([bytes[1], bytes[2]]) as usize;
            if bytes.len() < 3 + url_len {
                return Err(OnionError::InvalidPayload);
            }
            let url = String::from_utf8(bytes[3..3 + url_len].to_vec())
                .map_err(|_| OnionError::InvalidPayload)?;
            let inner = bytes[3 + url_len..].to_vec();
            Ok(OnionPayload::Forward { next_hop_url: url, inner_packet: inner })
        }
        0x02 => {
            if bytes.len() < 1 + 32 {
                return Err(OnionError::InvalidPayload);
            }
            let mut node_id = [0u8; 32];
            node_id.copy_from_slice(&bytes[1..33]);
            let message = bytes[33..].to_vec();
            Ok(OnionPayload::Deliver { destination_node_id: node_id, message })
        }
        _ => Err(OnionError::InvalidPayload),
    }
}

// ── Single layer crypto ───────────────────────────────────────────────────────

/// Encrypt `payload` for `hop_pubkey_bytes` (32-byte Ed25519 public key).
/// Returns a self-contained envelope the hop can decrypt with its Ed25519 seed.
pub fn encrypt_layer(payload: &OnionPayload, hop_pubkey_bytes: &[u8; 32]) -> Result<Vec<u8>, OnionError> {
    let recipient_x25519 = ed25519_pubkey_to_x25519(hop_pubkey_bytes);

    let ephemeral_secret = EphemeralSecret::random_from_rng(OsRng);
    let ephemeral_public = X25519Public::from(&ephemeral_secret);

    let shared = ephemeral_secret.diffie_hellman(&recipient_x25519);
    let aead_key = derive_aead_key(shared.as_bytes(), ephemeral_public.as_bytes(), HKDF_INFO);

    let plaintext = encode_payload(payload);
    let cipher = XChaCha20Poly1305::new_from_slice(&aead_key).map_err(|_| OnionError::Encrypt)?;
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_slice()).map_err(|_| OnionError::Encrypt)?;

    let mut out = Vec::with_capacity(1 + EPK_LEN + NONCE_LEN + ciphertext.len());
    out.push(VERSION);
    out.extend_from_slice(ephemeral_public.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt one onion layer using the recipient's 32-byte Ed25519 seed.
pub fn decrypt_layer(envelope: &[u8], recipient_seed_bytes: &[u8; 32]) -> Result<OnionPayload, OnionError> {
    if envelope.len() < MIN_LEN {
        return Err(OnionError::InvalidEnvelope);
    }
    if envelope[0] != VERSION {
        return Err(OnionError::UnsupportedVersion(envelope[0]));
    }

    let epk_bytes: [u8; 32]   = envelope[1..33].try_into().unwrap();
    let nonce_bytes: [u8; 24] = envelope[33..57].try_into().unwrap();
    let ciphertext = &envelope[57..];

    let ephemeral_public  = X25519Public::from(epk_bytes);
    let recipient_x25519  = ed25519_seed_to_x25519(recipient_seed_bytes);
    let shared            = recipient_x25519.diffie_hellman(&ephemeral_public);
    let aead_key          = derive_aead_key(shared.as_bytes(), &epk_bytes, HKDF_INFO);

    let cipher    = XChaCha20Poly1305::new_from_slice(&aead_key).map_err(|_| OnionError::Decrypt)?;
    let nonce     = XNonce::from_slice(&nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|_| OnionError::Decrypt)?;

    decode_payload(&plaintext)
}
```

### Step 4: Run tests — verify they pass

```bash
cd /Users/jdbohrman/delta/core
cargo test onion -- --nocapture
```

Expected: 5 tests pass.

Also verify sealed_sender still works:

```bash
cargo test sealed_sender -- --nocapture
```

Expected: 4 tests pass.

### Step 5: Commit

```bash
git add src/onion.rs src/lib.rs
git commit -m "feat(onion): single-layer XChaCha20 encrypt/decrypt with Ed25519→X25519 conversion"
```

---

## Task 3: Multi-Layer Packet Builder

Add `build_onion_packet` (wraps layers inside-out) and the public `OnionHop` type to `onion.rs`.

**Files:**
- Modify: `core/src/onion.rs` (add public types + builder)

### Step 1: Write the failing tests

Add to the `tests` module in `onion.rs`:

```rust
    #[test]
    fn build_and_peel_single_hop() {
        let (hop1_seed, hop1_pk) = random_keypair();
        let dest_node_id = [0x42u8; 32];
        let message = b"hello from delta";

        let hops = vec![OnionHop {
            pubkey_bytes: hop1_pk,
            next_url: "https://relay.example.com/hop".to_string(),
        }];

        let packet = build_onion_packet(&hops, &dest_node_id, message).unwrap();
        let payload = decrypt_layer(&packet, &hop1_seed).unwrap();

        match payload {
            OnionPayload::Deliver { destination_node_id, message: msg } => {
                assert_eq!(destination_node_id, dest_node_id);
                assert_eq!(msg, message);
            }
            _ => panic!("single-hop should produce Deliver at hop 1"),
        }
    }

    #[test]
    fn build_and_peel_three_hops() {
        let (hop1_seed, hop1_pk) = random_keypair();
        let (hop2_seed, hop2_pk) = random_keypair();
        let (hop3_seed, hop3_pk) = random_keypair();
        let dest_node_id = [0x99u8; 32];
        let message = b"three hop message";

        let hops = vec![
            OnionHop { pubkey_bytes: hop1_pk, next_url: "https://hop1.example.com/hop".to_string() },
            OnionHop { pubkey_bytes: hop2_pk, next_url: "https://hop2.example.com/hop".to_string() },
            OnionHop { pubkey_bytes: hop3_pk, next_url: "https://hop3.example.com/hop".to_string() },
        ];

        let packet = build_onion_packet(&hops, &dest_node_id, message).unwrap();

        // Hop 1 peels: gets Forward to hop2
        let layer1 = decrypt_layer(&packet, &hop1_seed).unwrap();
        let (url2, inner1) = match layer1 {
            OnionPayload::Forward { next_hop_url, inner_packet } => (next_hop_url, inner_packet),
            _ => panic!("hop1 should see Forward"),
        };
        assert_eq!(url2, "https://hop2.example.com/hop");

        // Hop 2 peels: gets Forward to hop3
        let layer2 = decrypt_layer(&inner1, &hop2_seed).unwrap();
        let (url3, inner2) = match layer2 {
            OnionPayload::Forward { next_hop_url, inner_packet } => (next_hop_url, inner_packet),
            _ => panic!("hop2 should see Forward"),
        };
        assert_eq!(url3, "https://hop3.example.com/hop");

        // Hop 3 peels: gets Deliver
        let layer3 = decrypt_layer(&inner2, &hop3_seed).unwrap();
        match layer3 {
            OnionPayload::Deliver { destination_node_id, message: msg } => {
                assert_eq!(destination_node_id, dest_node_id);
                assert_eq!(msg, message);
            }
            _ => panic!("hop3 should see Deliver"),
        }
    }

    #[test]
    fn empty_route_returns_error() {
        let hops: Vec<OnionHop> = vec![];
        assert!(build_onion_packet(&hops, &[0u8; 32], b"msg").is_err());
    }
```

### Step 2: Run to verify they fail

```bash
cargo test onion::tests::build -- --nocapture
```

Expected: compile errors (`OnionHop`, `build_onion_packet` not defined).

### Step 3: Implement `OnionHop` and `build_onion_packet`

Add to `onion.rs` (before the tests module):

```rust
// ── Public route types ────────────────────────────────────────────────────────

/// One hop in an onion route.
pub struct OnionHop {
    /// 32-byte Ed25519 public key of this hop (raw bytes, not hex).
    pub pubkey_bytes: [u8; 32],
    /// HTTP URL where this hop accepts onion packets (e.g. "https://relay.delta.app/hop").
    pub next_url: String,
}

// ── Packet builder ────────────────────────────────────────────────────────────

/// Build a fully layered onion packet addressed to `hops[0]`.
///
/// Route: hops[0] → hops[1] → ... → hops[N-1] → iroh deliver to `destination_node_id`.
///
/// The sender posts the returned bytes to `hops[0].next_url`.
/// Each hop peels one layer with `decrypt_layer()` and either:
///   - forwards the `inner_packet` to `next_hop_url`, or
///   - delivers `message` to the iroh relay for `destination_node_id`.
pub fn build_onion_packet(
    hops: &[OnionHop],
    destination_node_id: &[u8; 32],
    message: &[u8],
) -> Result<Vec<u8>, OnionError> {
    if hops.is_empty() {
        return Err(OnionError::EmptyRoute);
    }

    // Innermost layer: Deliver instruction for the last hop.
    let deliver = OnionPayload::Deliver {
        destination_node_id: *destination_node_id,
        message: message.to_vec(),
    };
    let mut current = encrypt_layer(&deliver, &hops[hops.len() - 1].pubkey_bytes)?;

    // Wrap remaining hops outside-in (second-to-last → first).
    for hop in hops[..hops.len() - 1].iter().rev() {
        let forward = OnionPayload::Forward {
            next_hop_url: hop.next_url.clone(),
            inner_packet: current,
        };
        current = encrypt_layer(&forward, &hop.pubkey_bytes)?;
    }

    Ok(current)
}
```

### Step 4: Run tests — verify they pass

```bash
cargo test onion -- --nocapture
```

Expected: all 8 tests pass (5 from Task 2 + 3 new).

### Step 5: Commit

```bash
git add src/onion.rs
git commit -m "feat(onion): multi-layer packet builder with inside-out wrapping"
```

---

## Task 4: UniFFI Exports

Expose `build_onion_packet` and `peel_onion_layer` through the FFI layer so React Native can call them.

**Files:**
- Modify: `core/src/delta_core.udl`
- Modify: `core/src/lib.rs`

### Step 1: Add types and functions to `delta_core.udl`

Add at the end of the `namespace delta_core { }` block (before the closing brace), after the existing blob functions:

```udl
    // ── Onion routing ──────────────────────────────────────────────────────
    [Throws=OnionError]
    bytes build_onion_packet(
        sequence<OnionHopFfi> hops,
        bytes destination_node_id,
        bytes message
    );

    [Throws=OnionError]
    OnionPeeled peel_onion_layer(bytes packet, string recipient_seed_hex);
```

Add the type definitions after the `BlobError` section at the bottom of the UDL file:

```udl
// ── Onion routing types ───────────────────────────────────────────────────────

dictionary OnionHopFfi {
    string pubkey_hex;
    string next_url;
};

dictionary OnionPeeled {
    string peel_type;      // "forward" | "deliver"
    string? next_hop_url;  // set when peel_type = "forward"
    bytes? inner_packet;   // set when peel_type = "forward"
    bytes? destination_node_id;  // set when peel_type = "deliver"
    bytes? message;              // set when peel_type = "deliver"
};

[Error]
enum OnionError {
    "EmptyRoute",
    "InvalidEnvelope",
    "UnsupportedVersion",
    "Encrypt",
    "Decrypt",
    "InvalidPayload",
    "InvalidKey",
};
```

### Step 2: Implement the FFI wrappers in `lib.rs`

First add the re-export near the top of `lib.rs` with the other `pub use` statements:

```rust
pub use onion::{OnionError, OnionHop};
```

Then add the two wrapper functions somewhere in `lib.rs` (near the pkarr functions is a sensible location):

```rust
// ── Onion routing ─────────────────────────────────────────────────────────────

/// FFI struct mirroring OnionHopFfi from the UDL.
pub struct OnionHopFfi {
    pub pubkey_hex: String,
    pub next_url: String,
}

/// FFI result struct for a peeled onion layer.
pub struct OnionPeeled {
    pub peel_type: String,
    pub next_hop_url: Option<String>,
    pub inner_packet: Option<Vec<u8>>,
    pub destination_node_id: Option<Vec<u8>>,
    pub message: Option<Vec<u8>>,
}

pub fn build_onion_packet(
    hops: Vec<OnionHopFfi>,
    destination_node_id: Vec<u8>,
    message: Vec<u8>,
) -> Result<Vec<u8>, OnionError> {
    if destination_node_id.len() != 32 {
        return Err(OnionError::InvalidKey("destination_node_id must be 32 bytes".to_string()));
    }
    let mut node_id = [0u8; 32];
    node_id.copy_from_slice(&destination_node_id);

    let onion_hops: Result<Vec<onion::OnionHop>, OnionError> = hops
        .into_iter()
        .map(|h| {
            let pk_bytes = hex::decode(&h.pubkey_hex)
                .map_err(|e| OnionError::InvalidKey(e.to_string()))?;
            if pk_bytes.len() != 32 {
                return Err(OnionError::InvalidKey("pubkey must be 32 bytes".to_string()));
            }
            let mut pk = [0u8; 32];
            pk.copy_from_slice(&pk_bytes);
            Ok(onion::OnionHop { pubkey_bytes: pk, next_url: h.next_url })
        })
        .collect();

    onion::build_onion_packet(&onion_hops?, &node_id, &message)
}

pub fn peel_onion_layer(
    packet: Vec<u8>,
    recipient_seed_hex: String,
) -> Result<OnionPeeled, OnionError> {
    let seed_bytes = hex::decode(&recipient_seed_hex)
        .map_err(|e| OnionError::InvalidKey(e.to_string()))?;
    if seed_bytes.len() != 32 {
        return Err(OnionError::InvalidKey("seed must be 32 bytes".to_string()));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&seed_bytes);

    match onion::decrypt_layer(&packet, &seed)? {
        onion::OnionPayload::Forward { next_hop_url, inner_packet } => Ok(OnionPeeled {
            peel_type: "forward".to_string(),
            next_hop_url: Some(next_hop_url),
            inner_packet: Some(inner_packet),
            destination_node_id: None,
            message: None,
        }),
        onion::OnionPayload::Deliver { destination_node_id, message } => Ok(OnionPeeled {
            peel_type: "deliver".to_string(),
            next_hop_url: None,
            inner_packet: None,
            destination_node_id: Some(destination_node_id.to_vec()),
            message: Some(message),
        }),
    }
}
```

### Step 3: Build to verify no compile errors

```bash
cd /Users/jdbohrman/delta/core
cargo build 2>&1 | tail -20
```

Expected: builds cleanly (no errors, warnings about unused items are OK).

### Step 4: Run all tests

```bash
cargo test -- --nocapture 2>&1 | tail -30
```

Expected: all tests pass.

### Step 5: Commit

```bash
git add src/delta_core.udl src/lib.rs
git commit -m "feat(onion): expose build_onion_packet and peel_onion_layer via UniFFI"
```

---

## Task 5: TypeScript Bindings

Wire the new FFI functions into `deltaCore.ts` so the React Native app can build and peel onion packets.

**Files:**
- Modify: `app/src/ffi/deltaCore.ts`

### Step 1: Add TypeScript types

Find the `PkarrResolved` interface in `deltaCore.ts` and add after it:

```typescript
export interface OnionHopFfi {
  pubkeyHex: string;
  nextUrl: string;
}

export interface OnionPeeled {
  peelType: 'forward' | 'deliver';
  nextHopUrl: string | null;
  innerPacket: Uint8Array | null;
  destinationNodeId: Uint8Array | null;
  message: Uint8Array | null;
}
```

### Step 2: Add wrapper functions

Add near the bottom of `deltaCore.ts`, after the `resolvePkarr` function:

```typescript
// ── Onion routing ─────────────────────────────────────────────────────────────

/**
 * Build a fully layered onion packet.
 *
 * @param hops       Ordered list of hops (first to last). Sender posts the result
 *                   to hops[0].nextUrl.
 * @param destNodeId 32-byte iroh node ID of the final destination.
 * @param message    Raw delta protocol bytes to deliver.
 * @returns          Onion packet bytes to POST to hops[0].nextUrl.
 */
export async function buildOnionPacket(
  hops: OnionHopFfi[],
  destNodeId: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  return native.buildOnionPacket(hops, destNodeId, message);
}

/**
 * Peel one layer of an onion packet using the local device's Ed25519 seed.
 *
 * @param packet           Raw onion envelope bytes.
 * @param recipientSeedHex Hex-encoded 32-byte Ed25519 seed (from the device keypair).
 * @returns                Decoded payload — either forward instructions or a delivery.
 */
export async function peelOnionLayer(
  packet: Uint8Array,
  recipientSeedHex: string,
): Promise<OnionPeeled> {
  return native.peelOnionLayer(packet, recipientSeedHex);
}
```

### Step 3: Verify TypeScript compiles

```bash
cd /Users/jdbohrman/delta/app
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors referencing `deltaCore.ts`.

### Step 4: Commit

```bash
cd /Users/jdbohrman/delta/app
git add src/ffi/deltaCore.ts
git commit -m "feat(onion): TypeScript bindings for buildOnionPacket and peelOnionLayer"
```

---

## What Comes Next (Out of Scope for This Plan)

These are the adjacent pieces that make the onion routing end-to-end useful. Each is a separate plan:

1. **Cloudflare Worker** (`packages/relay-worker/`) — HTTP endpoint that calls `peel_onion_layer` equivalent in TypeScript (using `@noble/curves` + `@noble/ciphers`), routes Forward packets via `fetch()`, and hands Deliver packets to the iroh relay bridge.

2. **Iroh relay HTTP bridge** — `POST /deliver` endpoint on the existing relay that accepts `{ node_id: hex, message: bytes }` and injects into the iroh network.

3. **Worker keypair in pkarr** — Relay Workers publish their X25519 public key (derived from Ed25519) to the DHT so clients can build routes to them.

4. **Route selection in the app** — Logic to pick N worker hops from known relay public keys and call `buildOnionPacket` before sending a delta message.

---

## Quick Reference

| Function | Location | Purpose |
|----------|----------|---------|
| `ed25519_seed_to_x25519` | `crypto.rs` | Ed25519 seed → X25519 static secret |
| `ed25519_pubkey_to_x25519` | `crypto.rs` | Ed25519 pubkey → X25519 pubkey |
| `derive_aead_key` | `crypto.rs` | HKDF-SHA256 → 32-byte AEAD key |
| `encrypt_layer` | `onion.rs` | Encrypt one onion layer to a hop's pubkey |
| `decrypt_layer` | `onion.rs` | Decrypt one layer with the device seed |
| `build_onion_packet` | `onion.rs` / `lib.rs` | Wrap N layers inside-out |
| `peel_onion_layer` | `lib.rs` | FFI wrapper for `decrypt_layer` |
| `buildOnionPacket` | `deltaCore.ts` | TypeScript → Rust FFI |
| `peelOnionLayer` | `deltaCore.ts` | TypeScript → Rust FFI |

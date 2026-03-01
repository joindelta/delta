//! Onion routing packet builder and peeler.
//!
//! Each layer: VERSION[1] | EPK[32] | NONCE[24] | CIPHERTEXT[N]
//! Payload:    TYPE[1] | ...
//!   Forward:  url_len:u16 | url | inner_packet
//!   Deliver:  topic_id[32] | op

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
    /// This hop is the exit — deliver `op` to the topic `topic_id`.
    Deliver {
        topic_id: [u8; 32],
        op: Vec<u8>,
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
        OnionPayload::Deliver { topic_id, op } => {
            let mut out = Vec::with_capacity(1 + 32 + op.len());
            out.push(0x02);
            out.extend_from_slice(topic_id);
            out.extend_from_slice(op);
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
            let mut topic_id = [0u8; 32];
            topic_id.copy_from_slice(&bytes[1..33]);
            let op = bytes[33..].to_vec();
            Ok(OnionPayload::Deliver { topic_id, op })
        }
        _ => Err(OnionError::InvalidPayload),
    }
}

// ── Onion hop ─────────────────────────────────────────────────────────────────

/// One hop in an onion route.
pub struct OnionHop {
    /// 32-byte Ed25519 public key of this hop (raw bytes, not hex).
    pub pubkey_bytes: [u8; 32],
    /// HTTP URL where this hop accepts onion packets (e.g. "https://relay.delta.app/hop").
    pub next_url: String,
}

// ── Single layer crypto ───────────────────────────────────────────────────────

/// Encrypt `payload` for `hop_pubkey_bytes` (32-byte Ed25519 public key).
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

// ── Multi-layer packet builder ────────────────────────────────────────────────

/// Build a fully layered onion packet addressed to `hops[0]`.
///
/// Route: hops[0] → hops[1] → ... → hops[N-1] → deliver `op` to `topic_id`.
///
/// The sender posts the returned bytes to `hops[0].next_url`.
pub fn build_onion_packet(
    hops: &[OnionHop],
    topic_id: &[u8; 32],
    op: &[u8],
) -> Result<Vec<u8>, OnionError> {
    if hops.is_empty() {
        return Err(OnionError::EmptyRoute);
    }

    // Innermost layer: Deliver instruction encrypted to the last hop's key.
    let deliver = OnionPayload::Deliver {
        topic_id: *topic_id,
        op: op.to_vec(),
    };
    let mut current = encrypt_layer(&deliver, &hops[hops.len() - 1].pubkey_bytes)?;

    // Wrap remaining hops outside-in.
    // For hops[i], the Forward payload tells it to POST the inner packet
    // to hops[i+1].next_url (the URL of the NEXT hop in the chain).
    for i in (0..hops.len() - 1).rev() {
        let forward = OnionPayload::Forward {
            next_hop_url: hops[i + 1].next_url.clone(),
            inner_packet: current,
        };
        current = encrypt_layer(&forward, &hops[i].pubkey_bytes)?;
    }

    Ok(current)
}

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
        let tid = [0xabu8; 32];
        let op_bytes = b"raw delta protocol bytes";
        let payload = OnionPayload::Deliver {
            topic_id: tid,
            op: op_bytes.to_vec(),
        };

        let envelope = encrypt_layer(&payload, &pubkey).unwrap();
        let recovered = decrypt_layer(&envelope, &seed).unwrap();

        match recovered {
            OnionPayload::Deliver { topic_id, op } => {
                assert_eq!(topic_id, tid);
                assert_eq!(op, op_bytes);
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

    #[test]
    fn build_and_peel_single_hop() {
        let (hop1_seed, hop1_pk) = random_keypair();
        let tid = [0x42u8; 32];
        let op_bytes = b"hello from delta";

        let hops = vec![OnionHop {
            pubkey_bytes: hop1_pk,
            next_url: "https://relay.example.com/hop".to_string(),
        }];

        let packet = build_onion_packet(&hops, &tid, op_bytes).unwrap();
        let payload = decrypt_layer(&packet, &hop1_seed).unwrap();

        match payload {
            OnionPayload::Deliver { topic_id, op } => {
                assert_eq!(topic_id, tid);
                assert_eq!(op, op_bytes);
            }
            _ => panic!("single-hop should produce Deliver at hop 1"),
        }
    }

    #[test]
    fn build_and_peel_three_hops() {
        let (hop1_seed, hop1_pk) = random_keypair();
        let (hop2_seed, hop2_pk) = random_keypair();
        let (hop3_seed, hop3_pk) = random_keypair();
        let tid = [0x99u8; 32];
        let op_bytes = b"three hop message";

        let hops = vec![
            OnionHop { pubkey_bytes: hop1_pk, next_url: "https://hop1.example.com/hop".to_string() },
            OnionHop { pubkey_bytes: hop2_pk, next_url: "https://hop2.example.com/hop".to_string() },
            OnionHop { pubkey_bytes: hop3_pk, next_url: "https://hop3.example.com/hop".to_string() },
        ];

        let packet = build_onion_packet(&hops, &tid, op_bytes).unwrap();

        // hop1 peels outermost: should see Forward to hop2's URL
        let layer1 = decrypt_layer(&packet, &hop1_seed).unwrap();
        let (url2, inner1) = match layer1 {
            OnionPayload::Forward { next_hop_url, inner_packet } => (next_hop_url, inner_packet),
            _ => panic!("hop1 should see Forward"),
        };
        assert_eq!(url2, "https://hop2.example.com/hop");

        // hop2 peels: should see Forward to hop3's URL
        let layer2 = decrypt_layer(&inner1, &hop2_seed).unwrap();
        let (url3, inner2) = match layer2 {
            OnionPayload::Forward { next_hop_url, inner_packet } => (next_hop_url, inner_packet),
            _ => panic!("hop2 should see Forward"),
        };
        assert_eq!(url3, "https://hop3.example.com/hop");

        // hop3 peels: Deliver
        let layer3 = decrypt_layer(&inner2, &hop3_seed).unwrap();
        match layer3 {
            OnionPayload::Deliver { topic_id, op } => {
                assert_eq!(topic_id, tid);
                assert_eq!(op, op_bytes);
            }
            _ => panic!("hop3 should see Deliver"),
        }
    }

    #[test]
    fn empty_route_returns_error() {
        let hops: Vec<OnionHop> = vec![];
        assert!(build_onion_packet(&hops, &[0u8; 32], b"msg").is_err());
    }
}

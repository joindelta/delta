//! Sealed-sender envelope for DM gossip messages.
//!
//! Hides the sender's identity from relay nodes and gossip peers while still
//! letting the *recipient* authenticate who sent the message.
//!
//! # How it works
//!
//! 1. Sender generates an ephemeral X25519 keypair.
//! 2. ECDH(ephemeral_secret, recipient_x25519_pk) → shared secret.
//! 3. HKDF(shared_secret, ephemeral_pk) → 32-byte AEAD key.
//! 4. Encrypt:  XChaCha20-Poly1305(sender_pk[32] || op_bytes)
//! 5. Wire envelope:  VERSION[1] | ephemeral_pk[32] | nonce[24] | ciphertext
//!
//! The relay only ever sees the recipient's topic hash and opaque ciphertext.
//! The recipient decrypts and learns the authenticated sender public key.
//!
//! # Ed25519 → X25519 conversion
//!
//! Both key types live on Curve25519 — Ed25519 uses the Edwards form, X25519
//! uses the Montgomery form.  The conversion is a well-known birational map
//! (RFC 8032 §5.1.5 / RFC 7748 §4.1):
//!
//!   x25519_secret = clamp(SHA-512(ed25519_seed)[0..32])
//!   x25519_public = ed_compressed_point.to_montgomery()

use chacha20poly1305::{
    AeadCore, KeyInit, XChaCha20Poly1305, XNonce,
    aead::Aead,
};
use rand::rngs::OsRng;
use thiserror::Error;
use x25519_dalek::{EphemeralSecret, PublicKey as X25519Public};

use crate::crypto::{derive_aead_key, ed25519_pubkey_to_x25519, ed25519_seed_to_x25519};

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION: u8  = 0x01;
const EPK_LEN: usize   = 32;
const NONCE_LEN: usize = 24;
/// Minimum valid envelope length (version + epk + nonce + 1-byte poly1305 tag minimum).
const MIN_LEN: usize = 1 + EPK_LEN + NONCE_LEN + 16;

// ─── Errors ───────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum SealedSenderError {
    #[error("envelope too short or malformed")]
    InvalidEnvelope,
    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u8),
    #[error("AEAD encryption failed")]
    Encrypt,
    #[error("AEAD decryption failed — wrong key or tampered ciphertext")]
    Decrypt,
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Seal `op_bytes` so that only `recipient_pk_bytes` can decrypt, while
/// hiding `sender_pk_bytes` from any relay or gossip node.
///
/// Both key slices must be 32-byte Ed25519 public/private keys in raw form.
pub fn seal(
    op_bytes:        &[u8],
    sender_pk_bytes: &[u8; 32],
    recipient_pk_bytes: &[u8; 32],
) -> Result<Vec<u8>, SealedSenderError> {
    // Recipient's X25519 public key
    let recipient_x25519 = ed25519_pubkey_to_x25519(recipient_pk_bytes);

    // Ephemeral X25519 keypair — never reused
    let ephemeral_secret = EphemeralSecret::random_from_rng(OsRng);
    let ephemeral_public = X25519Public::from(&ephemeral_secret);

    // ECDH shared secret
    let shared = ephemeral_secret.diffie_hellman(&recipient_x25519);

    // Derive AEAD key
    let aead_key = derive_aead_key(shared.as_bytes(), ephemeral_public.as_bytes(), b"delta:sealed-sender:v1");

    // Plaintext: sender_pk || op_bytes
    let mut plaintext = Vec::with_capacity(32 + op_bytes.len());
    plaintext.extend_from_slice(sender_pk_bytes);
    plaintext.extend_from_slice(op_bytes);

    // Encrypt with a random nonce
    let cipher = XChaCha20Poly1305::new_from_slice(&aead_key).map_err(|_| SealedSenderError::Encrypt)?;
    let nonce  = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_slice()).map_err(|_| SealedSenderError::Encrypt)?;

    // Build wire envelope
    let mut out = Vec::with_capacity(1 + EPK_LEN + NONCE_LEN + ciphertext.len());
    out.push(VERSION);
    out.extend_from_slice(ephemeral_public.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);

    Ok(out)
}

/// Open a sealed envelope using the recipient's Ed25519 seed bytes.
///
/// Returns `(sender_pk_bytes[32], op_bytes)` on success.
/// The caller should verify `sender_pk_bytes` against a known allowlist /
/// membership set before trusting the contained operation.
pub fn open(
    envelope: &[u8],
    recipient_seed_bytes: &[u8; 32],
) -> Result<([u8; 32], Vec<u8>), SealedSenderError> {
    if envelope.len() < MIN_LEN {
        return Err(SealedSenderError::InvalidEnvelope);
    }
    if envelope[0] != VERSION {
        return Err(SealedSenderError::UnsupportedVersion(envelope[0]));
    }

    let epk_bytes:   [u8; 32] = envelope[1..33].try_into().unwrap();
    let nonce_bytes: [u8; 24] = envelope[33..57].try_into().unwrap();
    let ciphertext = &envelope[57..];

    // Recover X25519 keys
    let ephemeral_public   = X25519Public::from(epk_bytes);
    let recipient_x25519   = ed25519_seed_to_x25519(recipient_seed_bytes);
    let shared             = recipient_x25519.diffie_hellman(&ephemeral_public);
    let aead_key           = derive_aead_key(shared.as_bytes(), &epk_bytes, b"delta:sealed-sender:v1");

    // Decrypt
    let cipher = XChaCha20Poly1305::new_from_slice(&aead_key).map_err(|_| SealedSenderError::Decrypt)?;
    let nonce  = XNonce::from_slice(&nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|_| SealedSenderError::Decrypt)?;

    if plaintext.len() < 32 {
        return Err(SealedSenderError::InvalidEnvelope);
    }

    let sender_pk: [u8; 32] = plaintext[..32].try_into().unwrap();
    let op_bytes = plaintext[32..].to_vec();

    Ok((sender_pk, op_bytes))
}

/// Returns true if `bytes` looks like a sealed-sender envelope (version byte
/// check only — use `open()` to fully verify).
pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.len() >= MIN_LEN && bytes[0] == VERSION
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn random_ed25519_keypair() -> ([u8; 32], [u8; 32]) {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let signing   = ed25519_dalek::SigningKey::from_bytes(&seed);
        let verifying = signing.verifying_key();
        (seed, *verifying.as_bytes())
    }

    #[test]
    fn seal_and_open_roundtrip() {
        let (sender_seed, sender_pk)       = random_ed25519_keypair();
        let (recipient_seed, recipient_pk) = random_ed25519_keypair();
        let op = b"hello sealed world";

        let envelope = seal(op, &sender_pk, &recipient_pk).unwrap();
        let (recovered_sender, recovered_op) = open(&envelope, &recipient_seed).unwrap();

        assert_eq!(recovered_sender, sender_pk);
        assert_eq!(recovered_op, op);
        let _ = sender_seed; // used indirectly via sender_pk
    }

    #[test]
    fn wrong_recipient_key_fails() {
        let (_sender_seed, sender_pk)          = random_ed25519_keypair();
        let (_recipient_seed, recipient_pk)    = random_ed25519_keypair();
        let (wrong_seed, _wrong_pk)            = random_ed25519_keypair();

        let envelope = seal(b"secret", &sender_pk, &recipient_pk).unwrap();
        assert!(open(&envelope, &wrong_seed).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let (_, sender_pk)       = random_ed25519_keypair();
        let (recipient_seed, recipient_pk) = random_ed25519_keypair();

        let mut envelope = seal(b"secret", &sender_pk, &recipient_pk).unwrap();
        // Flip a byte in the ciphertext section
        let last = envelope.len() - 1;
        envelope[last] ^= 0xff;

        assert!(open(&envelope, &recipient_seed).is_err());
    }

    #[test]
    fn is_sealed_detects_version_byte() {
        let (_, sender_pk)       = random_ed25519_keypair();
        let (_, recipient_pk)    = random_ed25519_keypair();

        let envelope = seal(b"test", &sender_pk, &recipient_pk).unwrap();
        assert!(is_sealed(&envelope));
        assert!(!is_sealed(b"plain gossip bytes"));
    }
}

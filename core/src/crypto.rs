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

/// Derive a 32-byte AEAD key from the X25519 shared secret + ephemeral pk.
/// Using the ephemeral pk as salt binds the key to this specific exchange.
pub fn derive_aead_key(shared: &[u8; 32], ephemeral_pk: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(ephemeral_pk), shared);
    let mut key = [0u8; 32];
    hk.expand(info, &mut key).expect("HKDF output length is valid");
    key
}

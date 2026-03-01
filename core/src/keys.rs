use bip39::Mnemonic;
use p2panda_core::identity::PrivateKey;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("invalid mnemonic: {0}")]
    InvalidMnemonic(String),
    #[error("invalid private key bytes")]
    InvalidPrivateKey,
}

/// Returned to JS via UniFFI — plain data, no Rust types exposed.
pub struct KeyPair {
    /// Hex-encoded Ed25519 private key (32 bytes → 64 hex chars). Never logged.
    pub private_key_hex: String,
    /// Hex-encoded Ed25519 public key (32 bytes → 64 hex chars). This is the peer identity.
    pub public_key_hex: String,
    /// Space-separated 24-word BIP-39 mnemonic. Shown once on first launch.
    pub mnemonic: String,
}

/// Generate a brand-new Ed25519 keypair and BIP-39 mnemonic.
pub fn generate_keypair() -> KeyPair {
    // Generate a 24-word (256-bit entropy) mnemonic.
    let mnemonic = Mnemonic::generate(24).expect("24-word mnemonic generation is infallible");

    keypair_from_mnemonic_internal(&mnemonic)
}

/// Derive an Ed25519 keypair from an existing 24-word BIP-39 mnemonic.
pub fn import_from_mnemonic(words: Vec<String>) -> Result<KeyPair, KeyError> {
    let phrase = words.join(" ");
    let mnemonic = phrase
        .parse::<Mnemonic>()
        .map_err(|e| KeyError::InvalidMnemonic(e.to_string()))?;

    Ok(keypair_from_mnemonic_internal(&mnemonic))
}

fn keypair_from_mnemonic_internal(mnemonic: &Mnemonic) -> KeyPair {
    // Derive 64-byte PBKDF2 seed (BIP-39 standard, no passphrase).
    let seed = mnemonic.to_seed("");
    // Use first 32 bytes as the Ed25519 private key seed.
    let seed_bytes: [u8; 32] = seed[..32].try_into().expect("seed is always 64 bytes");

    let private_key = PrivateKey::from_bytes(&seed_bytes);
    let public_key = private_key.public_key();

    let words: Vec<&str> = mnemonic.words().collect();

    KeyPair {
        private_key_hex: private_key.to_hex(),
        public_key_hex: public_key.to_hex(),
        mnemonic: words.join(" "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_and_reimport() {
        let kp1 = generate_keypair();
        assert_eq!(kp1.mnemonic.split_whitespace().count(), 24);
        assert_eq!(kp1.private_key_hex.len(), 64);
        assert_eq!(kp1.public_key_hex.len(), 64);

        let words: Vec<String> = kp1.mnemonic.split_whitespace().map(String::from).collect();
        let kp2 = import_from_mnemonic(words).expect("valid mnemonic");

        assert_eq!(kp1.private_key_hex, kp2.private_key_hex);
        assert_eq!(kp1.public_key_hex, kp2.public_key_hex);
    }

    #[test]
    fn bad_mnemonic_returns_error() {
        let bad: Vec<String> = vec!["not".into(), "valid".into()];
        assert!(import_from_mnemonic(bad).is_err());
    }
}

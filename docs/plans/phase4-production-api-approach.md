# Phase 4: Using Production APIs (No test_utils)

**Date:** 2026-02-21  
**Status:** Clarified

## Summary

Phase 4 encryption implementation should use production APIs from `p2panda-encryption` only. The `test_utils` feature provides convenience methods for testing but should NOT be used in production code.

## Production API Approach

### KeyManager Initialization

Instead of using `KeyManager::init_and_generate_prekey()` (test_utils only), use the production sequence:

```rust
use p2panda_encryption::crypto::{Rng, x25519::SecretKey};
use p2panda_encryption::key_manager::{KeyManager, KeyManagerState};
use p2panda_encryption::key_bundle::Lifetime;

// 1. Generate a fresh X25519 identity secret
let rng = Rng::from_entropy();
let identity = SecretKey::from_rng(&rng)?;

// 2. Initialize KeyManager
let km_state = KeyManager::init(&identity)?;

// 3. Create first prekey
let lifetime = Lifetime::default();
let km_state = KeyManager::rotate_prekey(km_state, lifetime, &rng)?;
```

### KeyRegistry Initialization

```rust
use p2panda_encryption::key_registry::{KeyRegistry, KeyRegistryState};
use p2panda_core::PublicKey;

// Initialize empty registry
let kr_state: KeyRegistryState<PublicKey> = KeyRegistry::init();

// Add bundles as they arrive
let kr_state = KeyRegistry::add_longterm_bundle(kr_state, peer_id, bundle)?;
```

### State Persistence

All state types (`KeyManagerState`, `KeyRegistryState`, `GroupState`) derive `Serialize` and `Deserialize`:

```rust
use ciborium;

// Serialize to CBOR
let mut buf = Vec::new();
ciborium::into_writer(&km_state, &mut buf)?;

// Deserialize from CBOR
let km_state: KeyManagerState = ciborium::from_reader(bytes.as_slice())?;
```

## What test_utils Provides (NOT NEEDED)

The `test_utils` feature only adds convenience for testing:

- `Rng::from_seed()` — deterministic RNG for reproducible tests
- `SecretKey::from_bytes()` — construct from raw bytes (we use `from_rng` instead)
- `KeyManager::init_and_generate_prekey()` — combines init + rotate (we do it in two steps)
- `Clone` implementations on some state types

These are purely for test ergonomics and should not be used in production.

## Implementation Strategy

### First Boot (No Persisted State)

```rust
// Generate fresh X25519 identity
let rng = Rng::from_entropy();
let identity = SecretKey::from_rng(&rng)?;

// Initialize KeyManager
let mut km_state = KeyManager::init(&identity)?;

// Generate first prekey
km_state = KeyManager::rotate_prekey(km_state, Lifetime::default(), &rng)?;

// Persist identity secret (encrypted) and km_state
save_identity_secret(&identity)?;
save_enc_key_manager(&km_state)?;

// Initialize empty KeyRegistry
let kr_state = KeyRegistry::init();
save_enc_key_registry(&kr_state)?;
```

### Subsequent Boots (Load Persisted State)

```rust
// Load persisted identity secret
let identity = load_identity_secret()?;

// Load KeyManagerState
let km_state: KeyManagerState = load_enc_key_manager()?;

// Load KeyRegistryState
let kr_state: KeyRegistryState<PublicKey> = load_enc_key_registry()?;

// Check if prekey needs rotation (optional)
// if prekey_lifetime_remaining < 3_days {
//     km_state = KeyManager::rotate_prekey(km_state, Lifetime::default(), &rng)?;
// }
```

## Key Differences from Original Plan

1. **No test_utils feature** — Keep `Cargo.toml` with only `data_scheme` and `message_scheme` features
2. **Separate init + rotate** — Use `KeyManager::init()` then `KeyManager::rotate_prekey()` instead of combined method
3. **Generate identity with from_rng** — Use `SecretKey::from_rng(&rng)` instead of `from_bytes()`
4. **Persist identity secret** — Store the X25519 identity secret separately (encrypted in DB) for key rotation

## Benefits

- Uses only public, stable APIs
- Follows production best practices
- Avoids dependency on test-only code
- Clearer separation of concerns (init vs. rotate)

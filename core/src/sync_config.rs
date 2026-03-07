//! Sync configuration — stores relay hops and sync URL set by `init_sync`.
//!
//! Uses plain (String, String) tuples for hop storage so this module has no
//! dependency on `lib.rs` types (avoiding a circular import).  The `lib.rs`
//! wrappers convert to/from `OnionHopFfi`.

use std::sync::OnceLock;

use hex;
use z32;

struct Inner {
    hops: Vec<(String, String)>, // (pubkey_hex, next_url)
    sync_url: String,
}

static CONFIG: OnceLock<std::sync::RwLock<Inner>> = OnceLock::new();

fn lock() -> &'static std::sync::RwLock<Inner> {
    CONFIG.get_or_init(|| {
        std::sync::RwLock::new(Inner {
            hops: vec![],
            sync_url: String::new(),
        })
    })
}

/// Store relay hops and the sync WebSocket URL.  May be called again when
/// relay discovery refreshes the hop list.
pub fn set(hops: Vec<(String, String)>, sync_url: String) {
    let mut g = lock().write().expect("sync config lock poisoned");
    g.hops = hops;
    g.sync_url = sync_url;
}

/// Return the stored relay hops as (pubkey_hex, next_url) pairs.
pub fn get_hops() -> Vec<(String, String)> {
    lock().read().expect("sync config lock poisoned").hops.clone()
}

/// Return the z32-encoded pubkey of the first relay hop, or None if not configured.
pub fn get_relay_z32() -> Option<String> {
    let hops = lock().read().expect("sync config lock poisoned").hops.clone();
    let (pubkey_hex, _) = hops.into_iter().next()?;
    let bytes = hex::decode(&pubkey_hex).ok()?;
    Some(z32::encode(&bytes))
}

/// Return the stored sync WebSocket URL, or an empty string if not yet set.
pub fn get_url() -> String {
    lock()
        .read()
        .expect("sync config lock poisoned")
        .sync_url
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset_config() {
        // Reset to empty state before each test
        set(vec![], String::new());
    }

    #[test]
    fn stores_relay_hops_and_retrieves_them() {
        reset_config();
        set(
            vec![
                ("aabb".repeat(16), "https://r1.example.com".to_string()),
                ("ccdd".repeat(16), "https://r2.example.com".to_string()),
            ],
            "wss://sync.example.com".to_string(),
        );

        let hops = get_hops();
        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0].0, "aabb".repeat(16));
        assert_eq!(hops[0].1, "https://r1.example.com");
        assert_eq!(hops[1].0, "ccdd".repeat(16));
        assert_eq!(hops[1].1, "https://r2.example.com");
    }

    #[test]
    fn stores_sync_url_and_retrieves_it() {
        reset_config();
        set(vec![], "wss://sync.example.com".to_string());
        assert_eq!(get_url(), "wss://sync.example.com");
    }

    #[test]
    fn overwriting_replaces_previous_config() {
        reset_config();
        set(
            vec![("aabb".repeat(16), "https://old.example.com".to_string())],
            "wss://old.example.com".to_string(),
        );
        set(
            vec![
                ("ccdd".repeat(16), "https://new1.example.com".to_string()),
                ("eeff".repeat(16), "https://new2.example.com".to_string()),
            ],
            "wss://new.example.com".to_string(),
        );

        let hops = get_hops();
        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0].1, "https://new1.example.com");
        assert_eq!(get_url(), "wss://new.example.com");
    }

    #[test]
    fn empty_hops_clears_list() {
        reset_config();
        set(
            vec![("aabb".repeat(16), "https://r1.example.com".to_string())],
            "wss://sync.example.com".to_string(),
        );
        set(vec![], "wss://sync.example.com".to_string());

        assert_eq!(get_hops().len(), 0);
    }
}

# Phase 3 Networking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add p2panda-net to core — real-time gossip delivery and LogSync catch-up — with a three-tier topic scheme (org-meta / room / DM) and a React Native connection indicator + public org discovery screen.

**Architecture:** A `NetworkCore` singleton (separate from `DeltaCore`) owns all p2panda-net handles. It is initialized automatically inside `bootstrap()` alongside the existing store setup. `ops::publish()` fire-and-forgets to gossip after writing to the store; incoming remote ops from LogSync flow into the same `DeltaStore` the projector already polls.

**Tech Stack:** p2panda-net 0.5.1, p2panda-core 0.5, p2panda-store 0.5 (SqliteStore), tokio, Zustand (RN), React Navigation.

**Design doc:** `docs/plans/2026-02-21-phase3-networking-design.md`

---

## Task 1: Add new types to UDL and lib.rs

**Files:**
- Modify: `core/src/delta_core.udl`
- Modify: `core/src/lib.rs`

**Step 1: Add `BootstrapNode` dict and `ConnectionStatus` enum to UDL**

In `delta_core.udl`, add below the existing `DmThread` dictionary:

```
enum ConnectionStatus {
    "Online",
    "Connecting",
    "Offline",
};

dictionary BootstrapNode {
    string node_id_hex;
    string relay_url;
};
```

**Step 2: Update `init_core` signature in UDL**

Replace:
```
[Async, Throws=CoreError]
void init_core(string private_key_hex, string db_dir);
```
With:
```
[Async, Throws=CoreError]
void init_core(string private_key_hex, string db_dir, sequence<BootstrapNode> bootstrap_nodes);
```

**Step 3: Add new function signatures to the UDL namespace**

After `list_dm_threads`, add:
```
[Async]
ConnectionStatus get_connection_status();

[Async, Throws=CoreError]
void subscribe_room_topic(string room_id);

[Async, Throws=CoreError]
void subscribe_dm_topic(string thread_id);

[Async]
sequence<OrgSummary> search_public_orgs(string query);
```

**Step 4: Add corresponding Rust types to lib.rs**

After the `CoreError` impl blocks, add:

```rust
// ── Phase 3 types ─────────────────────────────────────────────────────────────

pub struct BootstrapNode {
    pub node_id_hex: String,
    pub relay_url: String,
}

pub enum ConnectionStatus {
    Online,
    Connecting,
    Offline,
}
```

**Step 5: Update `init_core` signature in lib.rs**

Replace:
```rust
pub async fn init_core(private_key_hex: String, db_dir: String) -> Result<(), CoreError> {
    store::bootstrap(&private_key_hex, &db_dir)
        .await
        .map_err(CoreError::from)
}
```
With:
```rust
pub async fn init_core(
    private_key_hex: String,
    db_dir: String,
    bootstrap_nodes: Vec<BootstrapNode>,
) -> Result<(), CoreError> {
    store::bootstrap(&private_key_hex, &db_dir, bootstrap_nodes)
        .await
        .map_err(CoreError::from)
}
```

**Step 6: Add stub implementations for new UniFFI functions at the bottom of lib.rs**

```rust
// ── Phase 3: Network ──────────────────────────────────────────────────────────

pub async fn get_connection_status() -> ConnectionStatus {
    network::connection_status()
}

pub async fn subscribe_room_topic(room_id: String) -> Result<(), CoreError> {
    network::subscribe_room(&room_id).await.map_err(|e| CoreError::StoreError(e.to_string()))
}

pub async fn subscribe_dm_topic(thread_id: String) -> Result<(), CoreError> {
    network::subscribe_dm(&thread_id).await.map_err(|e| CoreError::StoreError(e.to_string()))
}

pub async fn search_public_orgs(query: String) -> Vec<OrgSummary> {
    network::search_public_orgs(&query)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(org_from_row)
        .collect()
}
```

**Step 7: cargo check**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | head -40
```
Expected: errors about missing `network::*` functions (fine — network.rs is still a stub). No UDL parse errors.

**Step 8: Commit**

```bash
git add core/src/delta_core.udl core/src/lib.rs
git commit -m "feat(phase3): add BootstrapNode, ConnectionStatus types and UniFFI stubs"
```

---

## Task 2: Topic derivation helpers + unit tests

**Files:**
- Modify: `core/src/network.rs`

Topic IDs are deterministic 32-byte values all parties derive independently. Use `p2panda_core::Hash` (BLAKE3) for derivation.

**Step 1: Write the failing tests first**

Replace the stub content of `network.rs` with:

```rust
//! Phase 3 — p2panda-net integration.

use p2panda_core::Hash;

// ─── Topic derivation ─────────────────────────────────────────────────────────

/// Namespaced prefix prevents collision with other p2panda apps.
const ORG_PREFIX:       &[u8] = b"delta:org:";
const ROOM_PREFIX:      &[u8] = b"delta:room:";
const DM_PREFIX:        &[u8] = b"delta:dm:";
const DISCOVER_PREFIX:  &[u8] = b"delta:discover:";

pub fn topic_id_for_org(org_id: &str) -> [u8; 32] {
    topic_hash(&[ORG_PREFIX, org_id.as_bytes()])
}

pub fn topic_id_for_room(room_id: &str) -> [u8; 32] {
    topic_hash(&[ROOM_PREFIX, room_id.as_bytes()])
}

/// DM topic is symmetric: both parties derive the same ID regardless of order.
pub fn topic_id_for_dm(key_a: &str, key_b: &str) -> [u8; 32] {
    let (lo, hi) = if key_a <= key_b { (key_a, key_b) } else { (key_b, key_a) };
    topic_hash(&[DM_PREFIX, lo.as_bytes(), b":", hi.as_bytes()])
}

pub fn topic_id_for_discovery(name: &str) -> [u8; 32] {
    let normalized = name.to_lowercase();
    topic_hash(&[DISCOVER_PREFIX, normalized.as_bytes()])
}

fn topic_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut buf = Vec::new();
    for p in parts { buf.extend_from_slice(p); }
    *Hash::new(&buf).as_bytes()
}

// ─── Stubs (filled in subsequent tasks) ──────────────────────────────────────

use crate::BootstrapNode;
use crate::db::OrgRow;

#[derive(Debug)]
pub struct NetworkError(pub String);

impl std::fmt::Display for NetworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "network error: {}", self.0)
    }
}

pub fn connection_status() -> crate::ConnectionStatus {
    crate::ConnectionStatus::Offline
}

pub async fn subscribe_room(_room_id: &str) -> Result<(), NetworkError> { Ok(()) }
pub async fn subscribe_dm(_thread_id: &str) -> Result<(), NetworkError> { Ok(()) }
pub async fn search_public_orgs(_query: &str) -> Result<Vec<OrgRow>, NetworkError> { Ok(vec![]) }
pub async fn init_network(
    _private_key_hex: &str,
    _db_dir: &str,
    _bootstrap_nodes: Vec<BootstrapNode>,
    _read_pool: &sqlx::SqlitePool,
) -> Result<(), NetworkError> { Ok(()) }

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_topic_is_deterministic() {
        let id = "abc123";
        assert_eq!(topic_id_for_org(id), topic_id_for_org(id));
    }

    #[test]
    fn room_topic_differs_from_org_topic() {
        let id = "abc123";
        assert_ne!(topic_id_for_org(id), topic_id_for_room(id));
    }

    #[test]
    fn dm_topic_is_symmetric() {
        let a = "aaaa";
        let b = "bbbb";
        assert_eq!(topic_id_for_dm(a, b), topic_id_for_dm(b, a));
    }

    #[test]
    fn dm_topic_differs_for_different_pairs() {
        assert_ne!(
            topic_id_for_dm("aaaa", "bbbb"),
            topic_id_for_dm("aaaa", "cccc"),
        );
    }

    #[test]
    fn discovery_topic_is_case_insensitive() {
        assert_eq!(
            topic_id_for_discovery("Rustaceans"),
            topic_id_for_discovery("rustaceans"),
        );
    }
}
```

**Step 2: Run tests to verify they pass**

```bash
cargo test --manifest-path core/Cargo.toml --lib network::tests 2>&1
```
Expected: 5 tests pass.

**Step 3: cargo check clean**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -20
```
Expected: no errors (stubs satisfy the call sites added in Task 1).

**Step 4: Commit**

```bash
git add core/src/network.rs
git commit -m "feat(phase3): topic derivation helpers + tests"
```

---

## Task 3: Update store.rs to accept bootstrap_nodes

**Files:**
- Modify: `core/src/store.rs`

**Step 1: Update `bootstrap()` signature**

Add `use crate::BootstrapNode;` at the top of `store.rs`, then update `bootstrap()`:

Replace:
```rust
pub async fn bootstrap(private_key_hex: &str, db_dir: &str) -> Result<(), StoreError> {
```
With:
```rust
pub async fn bootstrap(
    private_key_hex: &str,
    db_dir: &str,
    bootstrap_nodes: Vec<crate::BootstrapNode>,
) -> Result<(), StoreError> {
```

**Step 2: Call `init_network` at the end of `bootstrap()`, after spawning the projector**

Replace:
```rust
    // Spawn the projector.
    tokio::spawn(crate::projector::run_projector(read_pool));

    Ok(())
}
```
With:
```rust
    // Spawn the projector.
    tokio::spawn(crate::projector::run_projector(read_pool.clone()));

    // Bring up the network node.
    crate::network::init_network(
        private_key_hex,
        db_dir,
        bootstrap_nodes,
        &read_pool,
    )
    .await
    .map_err(|e| StoreError::Init(e.to_string()))?;

    Ok(())
}
```

**Step 3: cargo check**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -20
```
Expected: no errors.

**Step 4: Run existing tests**

```bash
cargo test --manifest-path core/Cargo.toml --lib 2>&1
```
Expected: all tests pass (network stubs are no-ops).

**Step 5: Commit**

```bash
git add core/src/store.rs
git commit -m "feat(phase3): wire bootstrap_nodes through bootstrap() to init_network"
```

---

## Task 4: DeltaTopicMap — dynamic topic-to-log mapping

**Files:**
- Modify: `core/src/network.rs`

`LogSync` needs a `TopicMap` implementation that maps `TopicId → Logs<LogId>`. Ours must be mutable at runtime (new rooms and DM threads are joined without restart).

> **Note:** Before writing this task, verify the exact `TopicMap` trait signature by running:
> ```bash
> cargo doc --manifest-path core/Cargo.toml --open
> ```
> Search for `p2panda_sync::TopicMap` or `p2panda_net::sync::TopicMap`. The trait likely has one method: `async fn get(&self, topic: &TopicId) -> Option<Logs<L>>` or a synchronous equivalent. Adjust the impl below if the signature differs.

**Step 1: Add `DeltaTopicMap` to network.rs**

After the `topic_hash` helper, insert:

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use p2panda_core::PublicKey;
// TopicMap and Logs come from p2panda_sync (re-exported via p2panda_net).
// If the import path differs, check: `use p2panda_net::sync::{TopicMap, Logs};`
use p2panda_net::sync::{Logs, TopicMap};

/// A single entry in the topic map: which (author, log_id) pairs to sync.
pub type LogEntry = (PublicKey, String);

/// Thread-safe, runtime-mutable mapping from TopicId bytes → log entries.
#[derive(Clone, Default)]
pub struct DeltaTopicMap {
    inner: Arc<RwLock<HashMap<[u8; 32], Vec<LogEntry>>>>,
}

impl DeltaTopicMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a set of (PublicKey, log_id) pairs for a topic.
    pub async fn insert(&self, topic_bytes: [u8; 32], logs: Vec<LogEntry>) {
        self.inner.write().await.insert(topic_bytes, logs);
    }

    /// Add a single log entry to an existing topic (or create it).
    pub async fn add_log(&self, topic_bytes: [u8; 32], entry: LogEntry) {
        self.inner
            .write()
            .await
            .entry(topic_bytes)
            .or_default()
            .push(entry);
    }
}

// Implement the TopicMap trait required by LogSync.
// Adjust generic parameters and method signature to match the actual trait.
impl TopicMap<[u8; 32], Logs<String>> for DeltaTopicMap {
    async fn get(&self, topic: &[u8; 32]) -> Option<Logs<String>> {
        let map = self.inner.read().await;
        map.get(topic).map(|entries| {
            Logs::from(entries.iter().map(|(pk, lid)| (pk.clone(), lid.clone())).collect::<Vec<_>>())
        })
    }
}
```

**Step 2: cargo check (expect possible trait import errors)**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -30
```

If the `TopicMap` / `Logs` import path is wrong, fix the `use` statement based on the error message. Common alternatives:
- `p2panda_net::sync::{TopicMap, Logs}`
- `p2panda_sync::{TopicMap, Logs}`

**Step 3: Commit once compiling**

```bash
git add core/src/network.rs
git commit -m "feat(phase3): DeltaTopicMap — runtime-mutable TopicId → logs mapping"
```

---

## Task 5: NetworkCore struct + full init_network()

**Files:**
- Modify: `core/src/network.rs`
- Modify: `core/Cargo.toml` (add `p2panda-sync` if needed)

This is the core task. Replace the `init_network` stub with the full p2panda-net initialization.

> **Note:** `p2panda-sync` may be a separate crate. If `cargo check` reports it missing, add to Cargo.toml:
> ```toml
> p2panda-sync = "0.5"
> ```

**Step 1: Add imports at top of network.rs**

```rust
use std::sync::OnceLock;
use std::time::Duration;

use p2panda_core::{Hash, PrivateKey, PublicKey};
use p2panda_net::{
    AddressBook, Discovery, Endpoint, Gossip, LogSync, MdnsDiscovery,
    address_book::NodeInfo,
};
use sqlx::SqlitePool;
use tokio::sync::Mutex;
```

**Step 2: Define `NetworkCore`**

```rust
pub struct NetworkCore {
    pub gossip: Gossip,
    pub sync: LogSync,
    pub topic_map: DeltaTopicMap,
    /// Gossip handles keyed by topic bytes — for publish().
    pub gossip_handles: Mutex<HashMap<[u8; 32], p2panda_net::GossipHandle>>,
    /// Sync handles keyed by topic bytes.
    pub sync_handles: Mutex<HashMap<[u8; 32], p2panda_net::SyncHandle>>,
    connected: std::sync::atomic::AtomicBool,
}

static NETWORK: OnceLock<NetworkCore> = OnceLock::new();

pub fn get_network() -> Option<&'static NetworkCore> {
    NETWORK.get()
}
```

**Step 3: Update `connection_status()` to use the atomic**

```rust
pub fn connection_status() -> crate::ConnectionStatus {
    match NETWORK.get() {
        None => crate::ConnectionStatus::Offline,
        Some(n) => {
            if n.connected.load(std::sync::atomic::Ordering::Relaxed) {
                crate::ConnectionStatus::Online
            } else {
                crate::ConnectionStatus::Connecting
            }
        }
    }
}
```

**Step 4: Replace `init_network` stub with full implementation**

```rust
pub async fn init_network(
    private_key_hex: &str,
    db_dir: &str,
    bootstrap_nodes: Vec<crate::BootstrapNode>,
    read_pool: &SqlitePool,
) -> Result<(), NetworkError> {
    if NETWORK.get().is_some() {
        return Ok(()); // idempotent
    }

    // Parse private key for the endpoint identity.
    let key_bytes = hex::decode(private_key_hex)
        .map_err(|e| NetworkError(format!("bad key hex: {e}")))?;
    let key_arr: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| NetworkError("expected 32 bytes".into()))?;
    let private_key = PrivateKey::from_bytes(&key_arr);

    // Build p2panda-net stack.
    let address_book = AddressBook::builder()
        .spawn()
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    let endpoint = Endpoint::builder(address_book.clone())
        .private_key(private_key.clone())
        .spawn()
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    // Insert bootstrap nodes.
    for node in &bootstrap_nodes {
        if let Ok(node_id_bytes) = hex::decode(&node.node_id_hex) {
            if let Ok(arr) = TryInto::<[u8; 32]>::try_into(node_id_bytes) {
                if let Ok(node_pub_key) = PublicKey::from_bytes(&arr) {
                    let node_id = p2panda_net::NodeId::from(node_pub_key);
                    let info = NodeInfo::new(node_id)
                        .bootstrap();
                    let _ = address_book.insert_node_info(info).await;
                }
            }
        }
    }

    let _mdns = MdnsDiscovery::builder(address_book.clone(), endpoint.clone())
        .spawn()
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    let _discovery = Discovery::builder(address_book.clone(), endpoint.clone())
        .spawn()
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    let gossip = Gossip::builder(address_book.clone(), endpoint.clone())
        .spawn()
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    let topic_map = DeltaTopicMap::new();

    // Give LogSync its own handle to the op store (SqlitePool is Arc-backed, Clone is cheap).
    let sync_store = {
        let url = format!("sqlite://{db_dir}/ops.db");
        let pool = p2panda_store::sqlite::store::connection_pool(&url, 2)
            .await
            .map_err(|e| NetworkError(e.to_string()))?;
        p2panda_store::sqlite::store::SqliteStore::new(pool)
    };

    let sync = LogSync::builder(sync_store, topic_map.clone(), endpoint.clone(), gossip.clone())
        .spawn()
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    let core = NetworkCore {
        gossip,
        sync,
        topic_map,
        gossip_handles: Mutex::new(HashMap::new()),
        sync_handles: Mutex::new(HashMap::new()),
        connected: std::sync::atomic::AtomicBool::new(false),
    };

    NETWORK.set(core).map_err(|_| NetworkError("already initialised".into()))?;

    // Subscribe to existing org-meta, room, and DM topics from the read model.
    subscribe_initial_topics(read_pool, private_key.public_key()).await?;

    // Mark as connected (optimistic — real status TBD via Discovery events).
    if let Some(net) = NETWORK.get() {
        net.connected.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    Ok(())
}
```

**Step 5: Add `subscribe_initial_topics` helper**

```rust
async fn subscribe_initial_topics(
    read_pool: &SqlitePool,
    my_key: PublicKey,
) -> Result<(), NetworkError> {
    let my_hex = my_key.to_hex();

    // Org-meta topics.
    let orgs = crate::db::list_orgs_for_member(read_pool, &my_hex)
        .await
        .unwrap_or_default();

    for org in &orgs {
        subscribe_org_meta(&org.org_id).await?;

        // Room topics for each org.
        let rooms = crate::db::list_rooms(read_pool, &org.org_id)
            .await
            .unwrap_or_default();
        for room in rooms {
            subscribe_room_inner(&room.room_id).await?;
        }
    }

    // DM thread topics.
    let threads = crate::db::list_dm_threads(read_pool, &my_hex)
        .await
        .unwrap_or_default();
    for thread in threads {
        let topic = topic_id_for_dm(&thread.initiator_key, &thread.recipient_key);
        subscribe_topic_inner(topic).await?;
    }

    Ok(())
}
```

**Step 6: Add inner subscription helpers**

```rust
/// Subscribe to an org-meta topic (profile, org, room ops for all known members).
pub async fn subscribe_org_meta(org_id: &str) -> Result<(), NetworkError> {
    let topic = topic_id_for_org(org_id);
    subscribe_topic_inner(topic).await
}

/// Subscribe to a room topic (message, reaction ops for room members).
pub async fn subscribe_room(room_id: &str) -> Result<(), NetworkError> {
    subscribe_room_inner(room_id).await
}

async fn subscribe_room_inner(room_id: &str) -> Result<(), NetworkError> {
    let topic = topic_id_for_room(room_id);
    subscribe_topic_inner(topic).await
}

/// Subscribe to a DM thread topic.
pub async fn subscribe_dm(thread_id: &str) -> Result<(), NetworkError> {
    let topic = topic_id_for_dm(thread_id, thread_id); // placeholder — see note
    subscribe_topic_inner(topic).await
}

async fn subscribe_topic_inner(topic_bytes: [u8; 32]) -> Result<(), NetworkError> {
    let net = match NETWORK.get() {
        Some(n) => n,
        None => return Ok(()), // network not up yet; will subscribe after init
    };

    let mut gossip_handles = net.gossip_handles.lock().await;
    if gossip_handles.contains_key(&topic_bytes) {
        return Ok(()); // already subscribed
    }

    // Create a gossip stream for this topic.
    // TopicId conversion: check p2panda_net docs — likely `TopicId::from(topic_bytes)`.
    let topic_id = p2panda_net::TopicId::from(topic_bytes);

    let gossip_handle = net
        .gossip
        .stream(topic_id)
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    // Subscribe and spawn a discard loop (gossip is ephemeral; real ops come via LogSync).
    let mut rx = gossip_handle.subscribe();
    tokio::spawn(async move {
        while let Some(_msg) = rx.next().await {
            // Gossip delivers ephemeral bytes; LogSync handles persistent ops.
            // Heartbeat-style messages can be handled here in future phases.
        }
    });

    gossip_handles.insert(topic_bytes, gossip_handle);

    // Also open a LogSync stream for this topic (live_mode = true).
    let mut sync_handles = net.sync_handles.lock().await;
    let sync_handle = net
        .sync
        .stream(topic_id, true)
        .await
        .map_err(|e| NetworkError(e.to_string()))?;
    sync_handles.insert(topic_bytes, sync_handle);

    Ok(())
}
```

> **Note on `subscribe_dm`:** The `subscribe_dm(thread_id)` helper called from `lib.rs` receives just the thread ID. To derive the DM topic we need both participant keys. In Task 7 you will fix this by looking up the thread from the read model. Leave the placeholder for now.

**Step 7: cargo check — iterate on import errors**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -40
```

Common fixes:
- `p2panda_net::NodeId` may be `p2panda_net::addrs::NodeId`
- `p2panda_net::GossipHandle` may be `p2panda_net::gossip::GossipHandle`
- `p2panda_net::SyncHandle` may be `p2panda_net::sync::SyncHandle`
- `p2panda_net::TopicId` may need `use p2panda_net::TopicId`
- `rx.next()` requires `use futures::StreamExt` — add `futures = "0.3"` to Cargo.toml if missing

Fix imports until `cargo check` is clean.

**Step 8: Run all tests**

```bash
cargo test --manifest-path core/Cargo.toml --lib 2>&1
```
Expected: all tests pass (including the 5 topic derivation tests from Task 2).

**Step 9: Commit**

```bash
git add core/src/network.rs core/Cargo.toml
git commit -m "feat(phase3): NetworkCore singleton + full init_network() implementation"
```

---

## Task 6: Fix subscribe_dm to look up thread participants

**Files:**
- Modify: `core/src/lib.rs`
- Modify: `core/src/network.rs`

The `subscribe_dm_topic(thread_id)` call in `lib.rs` has the read pool available. Use it.

**Step 1: Update `subscribe_dm_topic` in lib.rs**

Replace:
```rust
pub async fn subscribe_dm_topic(thread_id: String) -> Result<(), CoreError> {
    network::subscribe_dm(&thread_id).await.map_err(|e| CoreError::StoreError(e.to_string()))
}
```
With:
```rust
pub async fn subscribe_dm_topic(thread_id: String) -> Result<(), CoreError> {
    let core = store::get_core().ok_or(CoreError::NotInitialised)?;
    let thread = db::get_dm_thread(&core.read_pool, &thread_id)
        .await
        .map_err(CoreError::from)?
        .ok_or_else(|| CoreError::InvalidInput(format!("thread {} not found", thread_id)))?;
    network::subscribe_dm_thread(&thread.initiator_key, &thread.recipient_key)
        .await
        .map_err(|e| CoreError::StoreError(e.to_string()))
}
```

**Step 2: Add `get_dm_thread` to db.rs**

In `core/src/db.rs`, add after `list_dm_threads`:

```rust
pub async fn get_dm_thread(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Option<DmThreadRow>, DbError> {
    let row = sqlx::query_as!(
        DmThreadRow,
        r#"SELECT thread_id, initiator_key, recipient_key, created_at, last_message_at
           FROM dm_threads WHERE thread_id = ?"#,
        thread_id
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| DbError::Query(e.to_string()))?;
    Ok(row)
}
```

**Step 3: Replace `subscribe_dm` stub in network.rs**

Replace the placeholder `subscribe_dm`:
```rust
pub async fn subscribe_dm(thread_id: &str) -> Result<(), NetworkError> {
    let topic = topic_id_for_dm(thread_id, thread_id); // placeholder — see note
    subscribe_topic_inner(topic).await
}
```
With:
```rust
/// Called from lib.rs with both participant keys already resolved from the read model.
pub async fn subscribe_dm_thread(key_a: &str, key_b: &str) -> Result<(), NetworkError> {
    let topic = topic_id_for_dm(key_a, key_b);
    subscribe_topic_inner(topic).await
}
```

**Step 4: cargo check + tests**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -20
cargo test --manifest-path core/Cargo.toml --lib 2>&1
```
Expected: clean.

**Step 5: Commit**

```bash
git add core/src/lib.rs core/src/network.rs core/src/db.rs
git commit -m "feat(phase3): fix subscribe_dm to resolve participant keys from read model"
```

---

## Task 7: Gossip in ops::publish()

**Files:**
- Modify: `core/src/ops.rs`

After every successful store insert, fire-and-forget the CBOR op bytes to the appropriate gossip topic.

**Step 1: Add gossip dispatch at the end of `sign_and_store_op`**

In `ops.rs`, after the `store.insert_operation(...)` call, add:

```rust
    // Fire-and-forget gossip — we don't await; the network may not be up.
    let op_bytes = {
        let mut buf = Vec::with_capacity(header_bytes.len() + body_bytes.len() + 8);
        buf.extend_from_slice(&header_bytes);
        buf.extend_from_slice(&body_bytes);
        buf
    };
    let log_id_owned = log_id.to_string();
    tokio::spawn(async move {
        crate::network::gossip_op(&log_id_owned, &op_bytes).await;
    });

    Ok(op_hash)
```

> Replace the existing `Ok(op_hash)` line — don't add a duplicate return.

**Step 2: Add `gossip_op` to network.rs**

```rust
/// Broadcast op bytes to the gossip topic corresponding to this log type.
///
/// `log_id` is one of the `ops::log_ids::*` constants. The appropriate topic
/// is determined by inspecting the op payload (for messages/reactions we use
/// the room topic; for DMs the dm topic; everything else the org-meta topic).
///
/// For Phase 3 we use a simple heuristic: gossip on ALL subscribed topics.
/// Phase 4 will tighten this to the correct per-room / per-DM topic once
/// we have the room_id / thread_id in scope here.
pub async fn gossip_op(_log_id: &str, op_bytes: &[u8]) {
    let net = match NETWORK.get() {
        Some(n) => n,
        None => return,
    };
    let handles = net.gossip_handles.lock().await;
    for handle in handles.values() {
        let _ = handle.publish(op_bytes.to_vec()).await;
    }
}
```

**Step 3: cargo check + tests**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -20
cargo test --manifest-path core/Cargo.toml --lib 2>&1
```
Expected: clean.

**Step 4: Commit**

```bash
git add core/src/ops.rs core/src/network.rs
git commit -m "feat(phase3): gossip op bytes after every store insert"
```

---

## Task 8: search_public_orgs()

**Files:**
- Modify: `core/src/network.rs`
- Modify: `core/src/lib.rs`

**Step 1: Replace the `search_public_orgs` stub in network.rs**

```rust
/// Temporarily subscribe to discovery topic(s) for `query`, collect
/// OrgSummary gossip for up to 5 seconds, then unsubscribe.
pub async fn search_public_orgs(query: &str) -> Result<Vec<crate::db::OrgRow>, NetworkError> {
    let net = match NETWORK.get() {
        Some(n) => n,
        None => return Ok(vec![]),
    };

    let topic_bytes = topic_id_for_discovery(query);
    let topic_id = p2panda_net::TopicId::from(topic_bytes);

    let handle = net
        .gossip
        .stream(topic_id)
        .await
        .map_err(|e| NetworkError(e.to_string()))?;

    let mut rx = handle.subscribe();
    let mut results: Vec<crate::db::OrgRow> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

    loop {
        match tokio::time::timeout_at(deadline, rx.next()).await {
            Ok(Some(Ok(bytes))) => {
                // Peers broadcast OrgRow as CBOR on the discovery topic.
                if let Ok(org) = crate::ops::decode_cbor::<DiscoveryAnnounce>(&bytes) {
                    results.push(crate::db::OrgRow {
                        org_id: org.org_id,
                        name: org.name,
                        type_label: org.type_label,
                        description: org.description,
                        avatar_blob_id: None,
                        is_public: true,
                        creator_key: org.creator_key,
                        created_at: org.created_at,
                    });
                }
            }
            _ => break, // timeout or stream closed
        }
    }

    Ok(results)
}

/// CBOR payload broadcast by public orgs on their discovery topic.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DiscoveryAnnounce {
    pub org_id: String,
    pub name: String,
    pub type_label: String,
    pub description: Option<String>,
    pub creator_key: String,
    pub created_at: i64,
}
```

**Step 2: Broadcast discovery announce when creating a public org**

In `lib.rs`, in `create_org`, after `db::upsert_membership(...)`, add:

```rust
    // If public, broadcast a discovery announce on the org's discovery topic.
    if is_public {
        let announce = network::DiscoveryAnnounce {
            org_id: org_id.clone(),
            name: name.clone(),
            type_label: type_label.clone(),
            description: description.clone(),
            creator_key: core.public_key_hex.clone(),
            created_at: now,
        };
        if let Ok(bytes) = ops::encode_cbor(&announce) {
            let discovery_topic = network::topic_id_for_discovery(&name);
            tokio::spawn(async move {
                network::gossip_on_topic(discovery_topic, bytes).await;
            });
        }
        // Also subscribe to this org's org-meta topic.
        let _ = network::subscribe_org_meta(&org_id).await;
    }
```

**Step 3: Add `gossip_on_topic` helper to network.rs**

```rust
/// Gossip bytes on a specific topic (creates a one-shot stream if not already subscribed).
pub async fn gossip_on_topic(topic_bytes: [u8; 32], bytes: Vec<u8>) {
    let net = match NETWORK.get() {
        Some(n) => n,
        None => return,
    };
    let handles = net.gossip_handles.lock().await;
    if let Some(handle) = handles.get(&topic_bytes) {
        let _ = handle.publish(bytes).await;
    }
    // If not subscribed, silently drop — can only announce once subscribed.
}
```

**Step 4: cargo check + tests**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error" | head -20
cargo test --manifest-path core/Cargo.toml --lib 2>&1
```
Expected: clean.

**Step 5: Commit**

```bash
git add core/src/network.rs core/src/lib.rs
git commit -m "feat(phase3): search_public_orgs + discovery announce on create_org"
```

---

## Task 9: Final Rust verification

**Step 1: Run all tests**

```bash
cargo test --manifest-path core/Cargo.toml --lib 2>&1
```
Expected: at minimum the 5 topic derivation tests + any others pass.

**Step 2: cargo check clean**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error"
```
Expected: no output (zero errors).

**Step 3: Commit if any fixup changes were needed**

```bash
git add -p
git commit -m "fix(phase3): resolve any remaining cargo check warnings"
```

---

## Task 10: Update ffi/deltaCore.ts

**Files:**
- Modify: `app/src/ffi/deltaCore.ts`

**Step 1: Add new TypeScript types**

After the `KeyError` class, add:

```typescript
export interface BootstrapNode {
  nodeIdHex: string;
  relayUrl: string;
}

export type ConnectionStatus = 'Online' | 'Connecting' | 'Offline';

export const BOOTSTRAP_NODES: BootstrapNode[] = [
  // Hardcoded for launch — update relay_url when bootstrap node is deployed.
  // { nodeIdHex: '<64-hex-char-ed25519-pubkey>', relayUrl: 'https://relay.delta.app' },
];
```

**Step 2: Extend the `DeltaCoreNative` interface**

Replace the existing interface block:
```typescript
interface DeltaCoreNative {
  generateKeypair(): KeyPair;
  importFromMnemonic(words: string[]): KeyPair;
}
```
With:
```typescript
interface DeltaCoreNative {
  // Phase 1
  generateKeypair(): KeyPair;
  importFromMnemonic(words: string[]): KeyPair;
  // Phase 2
  initCore(privateKeyHex: string, dbDir: string, bootstrapNodes: BootstrapNode[]): Promise<void>;
  createOrUpdateProfile(username: string, bio: string | null, availableFor: string[]): Promise<void>;
  getMyProfile(): Promise<Profile | null>;
  getProfile(publicKey: string): Promise<Profile | null>;
  createOrg(name: string, typeLabel: string, description: string | null, isPublic: boolean): Promise<string>;
  listMyOrgs(): Promise<OrgSummary[]>;
  createRoom(orgId: string, name: string): Promise<string>;
  listRooms(orgId: string): Promise<Room[]>;
  sendMessage(
    roomId: string | null,
    dmThreadId: string | null,
    contentType: string,
    textContent: string | null,
    blobId: string | null,
    embedUrl: string | null,
    mentions: string[],
    replyTo: string | null,
  ): Promise<string>;
  listMessages(
    roomId: string | null,
    dmThreadId: string | null,
    limit: number,
    beforeTimestamp: number | null,
  ): Promise<Message[]>;
  createDmThread(recipientKey: string): Promise<string>;
  listDmThreads(): Promise<DmThread[]>;
  // Phase 3
  getConnectionStatus(): Promise<ConnectionStatus>;
  subscribeRoomTopic(roomId: string): Promise<void>;
  subscribeDmTopic(threadId: string): Promise<void>;
  searchPublicOrgs(query: string): Promise<OrgSummary[]>;
}
```

**Step 3: Add exported TypeScript types for Phase 2 data shapes**

Before `loadNative()`, add:

```typescript
export interface Profile {
  publicKey: string;
  username: string;
  avatarBlobId: string | null;
  bio: string | null;
  availableFor: string[];
  createdAt: number;
  updatedAt: number;
}

export interface OrgSummary {
  orgId: string;
  name: string;
  typeLabel: string;
  description: string | null;
  avatarBlobId: string | null;
  isPublic: boolean;
  creatorKey: string;
  createdAt: number;
}

export interface Room {
  roomId: string;
  orgId: string;
  name: string;
  createdBy: string;
  createdAt: number;
  encKeyEpoch: number;
}

export interface Message {
  messageId: string;
  roomId: string | null;
  dmThreadId: string | null;
  authorKey: string;
  contentType: string;
  textContent: string | null;
  blobId: string | null;
  embedUrl: string | null;
  mentions: string[];
  replyTo: string | null;
  timestamp: number;
  editedAt: number | null;
  isDeleted: boolean;
}

export interface DmThread {
  threadId: string;
  initiatorKey: string;
  recipientKey: string;
  createdAt: number;
  lastMessageAt: number | null;
}
```

**Step 4: Add exported wrapper functions for Phase 3**

At the bottom of the file:

```typescript
export async function initCore(
  privateKeyHex: string,
  dbDir: string,
  bootstrapNodes: BootstrapNode[] = BOOTSTRAP_NODES,
): Promise<void> {
  return native.initCore(privateKeyHex, dbDir, bootstrapNodes);
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  return native.getConnectionStatus();
}

export async function subscribeRoomTopic(roomId: string): Promise<void> {
  return native.subscribeRoomTopic(roomId);
}

export async function subscribeDmTopic(threadId: string): Promise<void> {
  return native.subscribeDmTopic(threadId);
}

export async function searchPublicOrgs(query: string): Promise<OrgSummary[]> {
  return native.searchPublicOrgs(query);
}
```

**Step 5: tsc check**

```bash
cd app && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors from deltaCore.ts.

**Step 6: Commit**

```bash
git add app/src/ffi/deltaCore.ts
git commit -m "feat(phase3): update ffi/deltaCore.ts with Phase 3 types and functions"
```

---

## Task 11: useNetworkStore

**Files:**
- Create: `app/src/stores/useNetworkStore.ts`

**Step 1: Create the store**

```typescript
import { create } from 'zustand';
import type { ConnectionStatus } from '../ffi/deltaCore';

interface NetworkState {
  status: ConnectionStatus;
  startPolling(): void;
  stopPolling(): void;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNative(): any {
  try { return require('delta_core'); } catch { return null; }
}

export const useNetworkStore = create<NetworkState>((set) => ({
  status: 'Offline',

  startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
      const native = getNative();
      if (!native) return;
      try {
        const status: ConnectionStatus = await native.getConnectionStatus();
        set({ status });
      } catch {
        set({ status: 'Offline' });
      }
    }, 3000);
  },

  stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  },
}));
```

**Step 2: tsc check**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```
Expected: clean.

**Step 3: Commit**

```bash
git add app/src/stores/useNetworkStore.ts
git commit -m "feat(phase3): useNetworkStore — polls get_connection_status every 3s"
```

---

## Task 12: ConnectionBadge component

**Files:**
- Create: `app/src/components/ConnectionBadge.tsx`

**Step 1: Create the component**

```typescript
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useNetworkStore } from '../stores/useNetworkStore';
import type { ConnectionStatus } from '../ffi/deltaCore';

const COLORS: Record<ConnectionStatus, string> = {
  Online:     '#22c55e', // green-500
  Connecting: '#f59e0b', // amber-500
  Offline:    '#6b7280', // gray-500
};

const LABELS: Record<ConnectionStatus, string> = {
  Online:     'Online',
  Connecting: 'Connecting',
  Offline:    'Offline',
};

export function ConnectionBadge() {
  const { status, startPolling, stopPolling } = useNetworkStore();

  useEffect(() => {
    startPolling();
    return stopPolling;
  }, [startPolling, stopPolling]);

  const color = COLORS[status];

  return (
    <View style={styles.row}>
      {status === 'Connecting' ? (
        <ActivityIndicator size={10} color={color} style={styles.dot} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <Text style={[styles.label, { color }]}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  dot:   { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  label: { fontSize: 12, fontWeight: '500' },
});
```

**Step 2: tsc check**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```
Expected: clean.

**Step 3: Commit**

```bash
git add app/src/components/ConnectionBadge.tsx
git commit -m "feat(phase3): ConnectionBadge — green/amber/grey dot in nav header"
```

---

## Task 13: Update useOrgsStore and useDMStore

**Files:**
- Modify: `app/src/stores/useOrgsStore.ts`
- Modify: `app/src/stores/useDMStore.ts`

**Step 1: useOrgsStore — call subscribeRoomTopic after createRoom**

In `useOrgsStore.ts`, replace:
```typescript
  async createRoom(orgId, name) {
    const native = getNative();
    if (!native) throw new Error('delta_core not loaded');
    const roomId: string = await native.createRoom(orgId, name);
    await get().fetchRooms(orgId);
    return roomId;
  },
```
With:
```typescript
  async createRoom(orgId, name) {
    const native = getNative();
    if (!native) throw new Error('delta_core not loaded');
    const roomId: string = await native.createRoom(orgId, name);
    await get().fetchRooms(orgId);
    // Subscribe to the new room's p2panda-net topic.
    try { await native.subscribeRoomTopic(roomId); } catch { /* non-fatal */ }
    return roomId;
  },
```

**Step 2: useDMStore — call subscribeDmTopic after createThread**

In `useDMStore.ts`, replace:
```typescript
  async createThread(recipientKey: string) {
    const native = getNative();
    if (!native) throw new Error('delta_core not loaded');
    const threadId: string = await native.createDmThread(recipientKey);
    await get().fetchThreads();
    return threadId;
  },
```
With:
```typescript
  async createThread(recipientKey: string) {
    const native = getNative();
    if (!native) throw new Error('delta_core not loaded');
    const threadId: string = await native.createDmThread(recipientKey);
    await get().fetchThreads();
    // Subscribe to the new DM thread's p2panda-net topic.
    try { await native.subscribeDmTopic(threadId); } catch { /* non-fatal */ }
    return threadId;
  },
```

**Step 3: tsc check**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```
Expected: clean.

**Step 4: Commit**

```bash
git add app/src/stores/useOrgsStore.ts app/src/stores/useDMStore.ts
git commit -m "feat(phase3): subscribe to room/DM topics after create"
```

---

## Task 14: DiscoverOrgsScreen

**Files:**
- Create: `app/src/screens/DiscoverOrgsScreen.tsx`

**Step 1: Create the screen**

```typescript
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import type { OrgSummary } from '../ffi/deltaCore';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNative(): any {
  try { return require('delta_core'); } catch { return null; }
}

export function DiscoverOrgsScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    const native = getNative();
    if (!native || !query.trim()) return;
    setLoading(true);
    setSearched(false);
    try {
      const orgs: OrgSummary[] = await native.searchPublicOrgs(query.trim());
      setResults(orgs);
    } catch (e) {
      setResults([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }

  function handleJoin(_org: OrgSummary) {
    Alert.alert('Coming soon', 'Joining orgs will be available in Phase 5.');
  }

  return (
    <View style={styles.root}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Search communities…"
          placeholderTextColor="#555"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.searchBtn} onPress={handleSearch}>
          <Text style={styles.searchBtnText}>Search</Text>
        </TouchableOpacity>
      </View>

      {loading && (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.hint}>Searching the network…</Text>
        </View>
      )}

      {!loading && searched && results.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.empty}>No communities found for "{query}"</Text>
          <Text style={styles.hint}>Try a different keyword, or check your connection.</Text>
        </View>
      )}

      <FlatList
        data={results}
        keyExtractor={item => item.orgId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardBody}>
              <Text style={styles.orgName}>{item.name}</Text>
              <Text style={styles.typeLabel}>{item.typeLabel}</Text>
              {item.description && (
                <Text style={styles.description} numberOfLines={2}>
                  {item.description}
                </Text>
              )}
            </View>
            <TouchableOpacity style={styles.joinBtn} onPress={() => handleJoin(item)}>
              <Text style={styles.joinBtnText}>Join</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },
  searchRow:   { flexDirection: 'row', margin: 16, gap: 8 },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 15,
  },
  searchBtn:     { backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  searchBtnText: { color: '#fff', fontWeight: '600' },
  center:        { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  empty:         { color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  hint:          { color: '#555', fontSize: 13, textAlign: 'center', marginTop: 8 },
  list:          { paddingHorizontal: 16, paddingBottom: 32 },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardBody:    { flex: 1 },
  orgName:     { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 2 },
  typeLabel:   { color: '#888', fontSize: 12, marginBottom: 4 },
  description: { color: '#aaa', fontSize: 13 },
  joinBtn:     { backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  joinBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
```

**Step 2: tsc check**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```
Expected: clean.

**Step 3: Commit**

```bash
git add app/src/screens/DiscoverOrgsScreen.tsx
git commit -m "feat(phase3): DiscoverOrgsScreen — search public orgs via p2panda DHT"
```

---

## Task 15: Wire navigation + ConnectionBadge

**Files:**
- Modify: `app/src/navigation/RootNavigator.tsx`

**Step 1: Add DiscoverOrgs to MainStackParamList**

Replace:
```typescript
export type MainStackParamList = {
  Home: undefined;
};
```
With:
```typescript
export type MainStackParamList = {
  Home: undefined;
  DiscoverOrgs: undefined;
};
```

**Step 2: Import new screen and component**

Add imports after the existing imports:
```typescript
import { DiscoverOrgsScreen } from '../screens/DiscoverOrgsScreen';
import { ConnectionBadge } from '../components/ConnectionBadge';
```

**Step 3: Add DiscoverOrgs to MainNavigator and ConnectionBadge to header**

Replace the `MainNavigator` function:
```typescript
function MainNavigator() {
  return (
    <MainStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0a0a0a' },
        headerTintColor: '#fff',
        headerRight: () => <ConnectionBadge />,
      }}
    >
      <MainStack.Screen name="Home" component={HomeScreen} />
      <MainStack.Screen
        name="DiscoverOrgs"
        component={DiscoverOrgsScreen}
        options={{ title: 'Discover Communities', headerShown: true }}
      />
    </MainStack.Navigator>
  );
}
```

**Step 4: tsc check**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```
Expected: clean.

**Step 5: Commit**

```bash
git add app/src/navigation/RootNavigator.tsx
git commit -m "feat(phase3): add DiscoverOrgs to nav + ConnectionBadge in header"
```

---

## Task 16: Final verification

**Step 1: Rust — full test suite**

```bash
cargo test --manifest-path core/Cargo.toml --lib 2>&1
```
Expected: all tests pass.

**Step 2: Rust — cargo check clean**

```bash
cargo check --manifest-path core/Cargo.toml 2>&1 | grep "^error"
```
Expected: no output.

**Step 3: TypeScript — tsc clean**

```bash
cd app && npx tsc --noEmit 2>&1
```
Expected: no errors.

**Step 4: Final commit**

```bash
git add -p  # stage any fixup changes
git commit -m "feat: Phase 3 complete — p2panda-net gossip + LogSync + public org discovery"
```

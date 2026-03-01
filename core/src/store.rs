//! P2Panda SqliteStore initialisation and the `DeltaCore` global singleton.
//!
//! The UniFFI `init_core()` function is the sole entry point called from
//! React Native after the biometric unlock provides the private key.

use std::sync::OnceLock;

use p2panda_core::PrivateKey;

// ─── Global multi-thread Tokio runtime ───────────────────────────────────────
//
// Using a multi-thread runtime so background tasks (projector, network) run on
// their own worker threads and cannot starve user-facing block_on callers via
// cooperative scheduling contention on a shared current_thread executor.

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn get_runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to create Tokio runtime")
    })
}

/// Run an async block using the global multi-thread runtime.
pub fn block_on<F, R>(f: F) -> R
where
    F: std::future::Future<Output = R>,
{
    get_runtime().block_on(f)
}
use p2panda_store::sqlite::store::{
    create_database, connection_pool, run_pending_migrations, SqliteStore,
};
use sqlx::SqlitePool;
use thiserror::Error;
use tokio::sync::Mutex;

// ─── Type alias ──────────────────────────────────────────────────────────────

/// p2panda-store instance parameterised with String log IDs and no extensions.
pub type DeltaStore = SqliteStore<String, ()>;

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("store init error: {0}")]
    Init(String),
    #[error("invalid private key hex: {0}")]
    BadKey(String),
    #[error("already initialised")]
    AlreadyInit,
    #[error("{0}")]
    Other(String),
}

// ─── Global singleton ────────────────────────────────────────────────────────

pub struct DeltaCore {
    pub private_key: PrivateKey,
    pub public_key_hex: String,
    /// Mutable because OperationStore methods take `&mut self`.
    pub op_store: Mutex<DeltaStore>,
    pub read_pool: SqlitePool,
    pub blob_store: std::path::PathBuf,
}

static CORE: OnceLock<DeltaCore> = OnceLock::new();

pub fn get_core() -> Option<&'static DeltaCore> {
    CORE.get()
}

// ─── Initialisation ──────────────────────────────────────────────────────────

/// Initialise the p2panda operation store at `{db_dir}/ops.db`.
pub async fn init_op_store(db_dir: &str) -> Result<DeltaStore, StoreError> {
    let url = format!("sqlite://{db_dir}/ops.db");
    create_database(&url)
        .await
        .map_err(|e| StoreError::Init(e.to_string()))?;
    let pool = connection_pool(&url, 5)
        .await
        .map_err(|e| StoreError::Init(e.to_string()))?;
    run_pending_migrations(&pool)
        .await
        .map_err(|e| StoreError::Init(e.to_string()))?;
    Ok(SqliteStore::new(pool))
}

/// Initialise the read-model SQLite pool at `{db_dir}/read.db`.
pub async fn init_read_pool(db_dir: &str) -> Result<SqlitePool, StoreError> {
    let url = format!("sqlite://{db_dir}/read.db?mode=rwc");
    SqlitePool::connect(&url)
        .await
        .map_err(|e| StoreError::Init(e.to_string()))
}

/// Called once from RN after biometric unlock.
///
/// * `private_key_hex` — 64 hex chars from iOS Keychain / Android Keystore.
/// * `db_dir` — writable directory path for SQLite files.
/// * `bootstrap_nodes` — relay nodes to connect to on startup.
pub async fn bootstrap(
    private_key_hex: &str,
    db_dir: &str,
    bootstrap_nodes: Vec<crate::BootstrapNode>,
) -> Result<(), StoreError> {
    if CORE.get().is_some() {
        return Ok(()); // already initialised; idempotent
    }

    // Parse key: decode hex → 32-byte array → PrivateKey.
    let key_bytes_vec =
        hex::decode(private_key_hex).map_err(|e| StoreError::BadKey(e.to_string()))?;
    let key_bytes: [u8; 32] = key_bytes_vec
        .try_into()
        .map_err(|_| StoreError::BadKey("expected 32 bytes (64 hex chars)".into()))?;
    let private_key = PrivateKey::from_bytes(&key_bytes);
    let public_key_hex = private_key.public_key().to_hex();

    // Init stores.
    let op_store = init_op_store(db_dir).await?;
    let read_pool = init_read_pool(db_dir).await?;

    // Apply read model schema.
    crate::db::run_migrations(&read_pool)
        .await
        .map_err(|e| StoreError::Init(e.to_string()))?;

    // Initialize blob store directory
    let blob_path = crate::blobs::blob_store_path(db_dir);
    std::fs::create_dir_all(&blob_path)
        .map_err(|e| StoreError::Init(format!("Failed to create blob directory: {}", e)))?;

    let core = DeltaCore {
        private_key,
        public_key_hex,
        op_store: Mutex::new(op_store),
        read_pool: read_pool.clone(),
        blob_store: blob_path,
    };

    CORE.set(core).map_err(|_| StoreError::AlreadyInit)?;

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

    // Initialize encryption subsystem (Phase 4)
    crate::encryption::init_encryption(private_key_hex.to_string(), read_pool.clone())
        .await
        .map_err(|e| StoreError::Other(e.to_string()))?;

    // Start pkarr republish loop for public profiles/orgs
    tokio::spawn(crate::pkarr_publish::start_republish_loop(read_pool.clone()));

    Ok(())
}

//! EncryptionCore — Phase 4 stub with DeltaDgm implementation.
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;

use p2panda_core::{Hash, PublicKey};
use p2panda_encryption::traits::{GroupMembership, IdentityHandle, OperationId};
use serde::{Deserialize, Serialize};

// ─── Local newtypes to satisfy marker trait orphan rules ──────────────────────
#[derive(Copy, Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Id(pub PublicKey);
#[derive(Copy, Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct OpId(pub Hash);

impl IdentityHandle for Id {}
impl OperationId for OpId {}

// ─── DeltaDgm — data scheme DGM ──────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaDgm;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaDgmState {
    pub my_id: Id,
    pub members: HashSet<Id>,
}

impl GroupMembership<Id, OpId> for DeltaDgm {
    type State = DeltaDgmState;
    type Error = Infallible;

    fn create(my_id: Id, initial_members: &[Id]) -> Result<Self::State, Self::Error> {
        Ok(DeltaDgmState {
            my_id,
            members: HashSet::from_iter(initial_members.iter().cloned()),
        })
    }

    fn from_welcome(my_id: Id, y: Self::State) -> Result<Self::State, Self::Error> {
        Ok(DeltaDgmState { my_id, members: y.members })
    }

    fn add(
        mut y: Self::State,
        _adder: Id,
        added: Id,
        _op: OpId,
    ) -> Result<Self::State, Self::Error> {
        y.members.insert(added);
        Ok(y)
    }

    fn remove(
        mut y: Self::State,
        _remover: Id,
        removed: &Id,
        _op: OpId,
    ) -> Result<Self::State, Self::Error> {
        y.members.remove(removed);
        Ok(y)
    }

    fn members(y: &Self::State) -> Result<HashSet<Id>, Self::Error> {
        Ok(y.members.clone())
    }
}

use p2panda_encryption::traits::AckedGroupMembership;

// ─── DeltaAckedDgm — message scheme DGM ──────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaAckedDgm;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaAckedDgmState {
    pub my_id: Id,
    pub members: HashSet<Id>,
    pub removed: HashSet<Id>,
    // op_id → (adder, added) for tracking adds awaiting ack
    pub pending_adds: HashMap<[u8; 32], (Id, Id)>,
    // op_id → (remover, removed) for tracking removes awaiting ack
    pub pending_removes: HashMap<[u8; 32], (Id, Id)>,
    // op_id → set of members who acked it
    pub acks: HashMap<[u8; 32], HashSet<Id>>,
}

impl AckedGroupMembership<Id, OpId> for DeltaAckedDgm {
    type State = DeltaAckedDgmState;
    type Error = Infallible;

    fn create(my_id: Id, initial_members: &[Id]) -> Result<Self::State, Self::Error> {
        Ok(DeltaAckedDgmState {
            my_id,
            members: HashSet::from_iter(initial_members.iter().cloned()),
            removed: HashSet::new(),
            pending_adds: Default::default(),
            pending_removes: Default::default(),
            acks: Default::default(),
        })
    }

    fn from_welcome(
        mut y: Self::State,
        y_welcome: Self::State,
    ) -> Result<Self::State, Self::Error> {
        y.members = y_welcome.members;
        y.removed = y_welcome.removed;
        Ok(y)
    }

    fn add(
        mut y: Self::State,
        adder: Id,
        added: Id,
        op: OpId,
    ) -> Result<Self::State, Self::Error> {
        let key: [u8; 32] = (&op.0).into();
        y.pending_adds.insert(key, (adder, added));
        y.members.insert(added);
        Ok(y)
    }

    fn remove(
        mut y: Self::State,
        remover: Id,
        removed: &Id,
        op: OpId,
    ) -> Result<Self::State, Self::Error> {
        let key: [u8; 32] = (&op.0).into();
        y.pending_removes.insert(key, (remover, *removed));
        y.members.remove(removed);
        y.removed.insert(*removed);
        Ok(y)
    }

    fn ack(
        mut y: Self::State,
        acker: Id,
        op: OpId,
    ) -> Result<Self::State, Self::Error> {
        let key: [u8; 32] = (&op.0).into();
        y.acks.entry(key).or_default().insert(acker);
        Ok(y)
    }

    fn members_view(
        y: &Self::State,
        _viewer: &Id,
    ) -> Result<HashSet<Id>, Self::Error> {
        Ok(y.members.clone())
    }

    fn is_add(y: &Self::State, op: OpId) -> bool {
        let key: [u8; 32] = (&op.0).into();
        y.pending_adds.contains_key(&key)
    }

    fn is_remove(y: &Self::State, op: OpId) -> bool {
        let key: [u8; 32] = (&op.0).into();
        y.pending_removes.contains_key(&key)
    }
}

// ─── Task 6: DeltaOrdering — Ordering<PublicKey, Hash, DeltaDgm> for rooms ───

use std::collections::VecDeque;
use p2panda_encryption::crypto::xchacha20::XAeadNonce;
use p2panda_encryption::data_scheme::GroupSecretId;
use p2panda_encryption::data_scheme::{
    ControlMessage as DataControlMessage,
    DirectMessage as DataDirectMessage,
};
use p2panda_encryption::traits::{GroupMessage, GroupMessageContent, Ordering};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum DeltaMessageContent {
    Control {
        ctrl: DataControlMessage<Id>,
        directs: Vec<DataDirectMessage<Id, OpId, DeltaDgm>>,
    },
    Application {
        group_secret_id: GroupSecretId,
        nonce: XAeadNonce,
        ciphertext: Vec<u8>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaMessage {
    pub id: OpId,
    pub sender: Id,
    pub content: DeltaMessageContent,
}

impl GroupMessage<Id, OpId, DeltaDgm> for DeltaMessage {
    fn id(&self) -> OpId { self.id }
    fn sender(&self) -> Id { self.sender }
    fn content(&self) -> GroupMessageContent<Id> {
        match &self.content {
            DeltaMessageContent::Control { ctrl, .. } =>
                GroupMessageContent::Control(ctrl.clone()),
            DeltaMessageContent::Application { group_secret_id, nonce, ciphertext } =>
                GroupMessageContent::Application {
                    group_secret_id: *group_secret_id,
                    nonce: *nonce,
                    ciphertext: ciphertext.clone(),
                },
        }
    }
    fn direct_messages(&self) -> Vec<DataDirectMessage<Id, OpId, DeltaDgm>> {
        match &self.content {
            DeltaMessageContent::Control { directs, .. } => directs.clone(),
            _ => vec![],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaOrderingState {
    my_id: Id,
    next_seq: u64,
    queue: VecDeque<DeltaMessage>,
    welcomed: bool,
}

#[derive(Debug)]
pub struct DeltaOrdering;

impl DeltaOrdering {
    pub fn init(my_id: PublicKey) -> DeltaOrderingState {
        DeltaOrderingState { my_id: Id(my_id), next_seq: 0, queue: VecDeque::new(), welcomed: false }
    }
}

impl Ordering<Id, OpId, DeltaDgm> for DeltaOrdering {
    type State = DeltaOrderingState;
    type Error = Infallible;
    type Message = DeltaMessage;

    fn next_control_message(
        mut y: Self::State,
        ctrl: &DataControlMessage<Id>,
        directs: &[DataDirectMessage<Id, OpId, DeltaDgm>],
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        let seq_bytes = y.next_seq.to_be_bytes();
        let id = OpId(Hash::new(&seq_bytes));
        y.next_seq += 1;
        let msg = DeltaMessage {
            id,
            sender: y.my_id,
            content: DeltaMessageContent::Control { ctrl: ctrl.clone(), directs: directs.to_vec() },
        };
        Ok((y, msg))
    }

    fn next_application_message(
        mut y: Self::State,
        group_secret_id: GroupSecretId,
        nonce: XAeadNonce,
        ciphertext: Vec<u8>,
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        let seq_bytes = y.next_seq.to_be_bytes();
        let id = OpId(Hash::new(&seq_bytes));
        y.next_seq += 1;
        let msg = DeltaMessage {
            id,
            sender: y.my_id,
            content: DeltaMessageContent::Application { group_secret_id, nonce, ciphertext },
        };
        Ok((y, msg))
    }

    fn queue(mut y: Self::State, message: &Self::Message) -> Result<Self::State, Self::Error> {
        y.queue.push_back(message.clone());
        Ok(y)
    }

    fn set_welcome(mut y: Self::State, _msg: &Self::Message) -> Result<Self::State, Self::Error> {
        y.welcomed = true;
        Ok(y)
    }

    fn next_ready_message(
        mut y: Self::State,
    ) -> Result<(Self::State, Option<Self::Message>), Self::Error> {
        if !y.welcomed { return Ok((y, None)); }
        let msg = y.queue.pop_front();
        Ok((y, msg))
    }
}

// ─── Task 7: DeltaFsOrdering — ForwardSecureOrdering for DMs ───────────────────

use p2panda_encryption::message_scheme::{
    ControlMessage as MsgControlMessage,
    DirectMessage as MsgDirectMessage,
    Generation,
};
use p2panda_encryption::traits::{
    ForwardSecureGroupMessage, ForwardSecureMessageContent, ForwardSecureOrdering,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum DeltaFsMessageContent {
    Control {
        ctrl: MsgControlMessage<Id, OpId>,
        directs: Vec<MsgDirectMessage<Id, OpId, DeltaAckedDgm>>,
    },
    Application {
        generation: Generation,
        ciphertext: Vec<u8>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaFsMessage {
    pub id: OpId,
    pub sender: Id,
    pub content: DeltaFsMessageContent,
}

impl ForwardSecureGroupMessage<Id, OpId, DeltaAckedDgm> for DeltaFsMessage {
    fn id(&self) -> OpId { self.id }
    fn sender(&self) -> Id { self.sender }
    fn content(&self) -> ForwardSecureMessageContent<Id, OpId> {
        match &self.content {
            DeltaFsMessageContent::Control { ctrl, .. } =>
                ForwardSecureMessageContent::Control(ctrl.clone()),
            DeltaFsMessageContent::Application { generation, ciphertext } =>
                ForwardSecureMessageContent::Application { generation: *generation, ciphertext: ciphertext.clone() },
        }
    }
    fn direct_messages(&self) -> Vec<MsgDirectMessage<Id, OpId, DeltaAckedDgm>> {
        match &self.content {
            DeltaFsMessageContent::Control { directs, .. } => directs.clone(),
            _ => vec![],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeltaFsOrderingState {
    my_id: Id,
    next_seq: u64,
    queue: VecDeque<DeltaFsMessage>,
    welcomed: bool,
}

#[derive(Debug)]
pub struct DeltaFsOrdering;

impl DeltaFsOrdering {
    pub fn init(my_id: PublicKey) -> DeltaFsOrderingState {
        DeltaFsOrderingState { my_id: Id(my_id), next_seq: 0, queue: VecDeque::new(), welcomed: false }
    }
}

impl ForwardSecureOrdering<Id, OpId, DeltaAckedDgm> for DeltaFsOrdering {
    type State = DeltaFsOrderingState;
    type Error = Infallible;
    type Message = DeltaFsMessage;

    fn next_control_message(
        mut y: Self::State,
        ctrl: &MsgControlMessage<Id, OpId>,
        directs: &[MsgDirectMessage<Id, OpId, DeltaAckedDgm>],
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        let id = OpId(Hash::new(&y.next_seq.to_be_bytes()));
        y.next_seq += 1;
        let msg = DeltaFsMessage { id, sender: y.my_id, content: DeltaFsMessageContent::Control { ctrl: ctrl.clone(), directs: directs.to_vec() } };
        Ok((y, msg))
    }

    fn next_application_message(
        mut y: Self::State,
        generation: Generation,
        ciphertext: Vec<u8>,
    ) -> Result<(Self::State, Self::Message), Self::Error> {
        let id = OpId(Hash::new(&y.next_seq.to_be_bytes()));
        y.next_seq += 1;
        let msg = DeltaFsMessage { id, sender: y.my_id, content: DeltaFsMessageContent::Application { generation, ciphertext } };
        Ok((y, msg))
    }

    fn queue(mut y: Self::State, msg: &Self::Message) -> Result<Self::State, Self::Error> {
        y.queue.push_back(msg.clone());
        Ok(y)
    }

    fn set_welcome(mut y: Self::State, _msg: &Self::Message) -> Result<Self::State, Self::Error> {
        y.welcomed = true;
        Ok(y)
    }

    fn next_ready_message(
        mut y: Self::State,
    ) -> Result<(Self::State, Option<Self::Message>), Self::Error> {
        if !y.welcomed { return Ok((y, None)); }
        let msg = y.queue.pop_front();
        Ok((y, msg))
    }
}

#[cfg(test)]
mod dgm_tests {
    use super::*;
    use p2panda_core::PrivateKey;

    fn id() -> Id { Id(PrivateKey::new().public_key()) }

    #[test]
    fn create_contains_initial_members() {
        let me = id(); let alice = id(); let bob = id();
        let state = DeltaDgm::create(me, &[alice, bob]).unwrap();
        let members = DeltaDgm::members(&state).unwrap();
        assert!(members.contains(&alice));
        assert!(members.contains(&bob));
    }

    #[test]
    fn add_member() {
        let me = id(); let alice = id();
        let state = DeltaDgm::create(me, &[]).unwrap();
        let state = DeltaDgm::add(state, me, alice, OpId(Hash::new(b"op1"))).unwrap();
        assert!(DeltaDgm::members(&state).unwrap().contains(&alice));
    }

    #[test]
    fn remove_member() {
        let me = id(); let alice = id();
        let state = DeltaDgm::create(me, &[alice]).unwrap();
        let state = DeltaDgm::remove(state, me, &alice, OpId(Hash::new(b"op1"))).unwrap();
        assert!(!DeltaDgm::members(&state).unwrap().contains(&alice));
    }

    #[test]
    fn from_welcome_preserves_members() {
        let me = id(); let alice = id();
        let state = DeltaDgm::create(me, &[alice]).unwrap();
        let welcomed = DeltaDgm::from_welcome(me, state).unwrap();
        assert!(DeltaDgm::members(&welcomed).unwrap().contains(&alice));
    }

    #[test]
    fn acked_dgm_create_and_members() {
        let me = id(); let alice = id();
        let state = DeltaAckedDgm::create(me, &[alice]).unwrap();
        let members = DeltaAckedDgm::members_view(&state, &me).unwrap();
        assert!(members.contains(&alice));
    }

    #[test]
    fn acked_dgm_add_and_ack() {
        let me = id(); let alice = id();
        let op = OpId(Hash::new(b"add_op"));
        let state = DeltaAckedDgm::create(me, &[]).unwrap();
        let state = DeltaAckedDgm::add(state, me, alice, op).unwrap();
        let state = DeltaAckedDgm::ack(state, alice, op).unwrap();
        let members = DeltaAckedDgm::members_view(&state, &me).unwrap();
        assert!(members.contains(&alice));
    }

    #[test]
    fn ordering_queue_and_dequeue() {
        use p2panda_encryption::data_scheme::ControlMessage;
        let me_pk = PrivateKey::new().public_key();
        let state = DeltaOrdering::init(me_pk);
        let dummy_ctrl = ControlMessage::Create { initial_members: vec![] };
        let (state, msg) = DeltaOrdering::next_control_message(state, &dummy_ctrl, &[]).unwrap();
        let state = DeltaOrdering::set_welcome(state, &msg).unwrap();
        let state = DeltaOrdering::queue(state, &msg).unwrap();
        let (_state, ready) = DeltaOrdering::next_ready_message(state).unwrap();
        assert!(ready.is_some());
    }

    #[test]
    fn fs_ordering_queue_and_dequeue() {
        use p2panda_encryption::message_scheme::ControlMessage as MsgCtrl;
        let me_pk = PrivateKey::new().public_key();
        let state = DeltaFsOrdering::init(me_pk);
        let dummy_ctrl = MsgCtrl::Create { initial_members: vec![] };
        let (state, msg) = DeltaFsOrdering::next_control_message(state, &dummy_ctrl, &[]).unwrap();
        let state = DeltaFsOrdering::set_welcome(state, &msg).unwrap();
        let state = DeltaFsOrdering::queue(state, &msg).unwrap();
        let (_state, ready) = DeltaFsOrdering::next_ready_message(state).unwrap();
        assert!(ready.is_some());
    }
}

// ─── EncryptionCore singleton + init_encryption (Task 8) ─────────────────────

use std::sync::OnceLock;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use p2panda_encryption::key_manager::{KeyManager, KeyManagerState};
use p2panda_encryption::key_registry::{KeyRegistry, KeyRegistryState};
use p2panda_encryption::key_bundle::Lifetime;
use p2panda_encryption::data_scheme::{GroupState};
use p2panda_encryption::message_scheme::{GroupState as MsgGroupState};
use p2panda_encryption::crypto::{Rng, x25519::SecretKey as X25519SecretKey};
use p2panda_encryption::traits::PreKeyManager;

// Concrete GroupState type aliases.
pub type DeltaGroupState = GroupState<
    Id, OpId,
    KeyRegistry<Id>,
    DeltaDgm,
    KeyManager,
    DeltaOrdering,
>;

pub type DeltaMsgGroupState = MsgGroupState<
    Id, OpId,
    KeyRegistry<Id>,
    DeltaAckedDgm,
    KeyManager,
    DeltaFsOrdering,
>;

pub struct EncryptionCore {
    pub key_manager:  Mutex<KeyManagerState>,
    pub key_registry: Mutex<KeyRegistryState<Id>>,
    pub read_pool:    SqlitePool,
    pub my_public_key: PublicKey,
}

static ENCRYPTION: OnceLock<EncryptionCore> = OnceLock::new();

pub fn get_encryption() -> Option<&'static EncryptionCore> {
    ENCRYPTION.get()
}

#[derive(Debug, thiserror::Error)]
pub enum EncryptionError {
    #[error("init error: {0}")]
    Init(String),
    #[error("not initialised")]
    NotInitialised,
    #[error("database error: {0}")]
    Db(#[from] crate::db::DbError),
    #[error("cbor error: {0}")]
    Cbor(String),
}

pub async fn init_encryption(
    private_key_hex: String,
    read_pool: SqlitePool,
) -> Result<(), EncryptionError> {
    if ENCRYPTION.get().is_some() { return Ok(()); }

    let pk_bytes = hex::decode(&private_key_hex)
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let private_key = p2panda_core::PrivateKey::try_from(pk_bytes.as_slice())
        .map_err(|e| EncryptionError::Init(e.to_string()))?;
    let my_public_key = private_key.public_key();

    // Create RNG for key generation
    let rng = Rng::default();

    // Load or create KeyManagerState using production APIs.
    let km_state = match crate::db::load_enc_key_manager(&read_pool).await? {
        Some(bytes) => {
            ciborium::from_reader::<KeyManagerState, _>(bytes.as_slice())
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?
        }
        None => {
            // Production API sequence: generate fresh X25519 identity, init, then rotate_prekey
            let identity = X25519SecretKey::from_rng(&rng)
                .map_err(|e| EncryptionError::Init(e.to_string()))?;
            
            let mut state = KeyManager::init(&identity)
                .map_err(|e| EncryptionError::Init(e.to_string()))?;
            
            state = KeyManager::rotate_prekey(state, Lifetime::default(), &rng)
                .map_err(|e| EncryptionError::Init(e.to_string()))?;
            
            let mut buf = Vec::new();
            ciborium::into_writer(&state, &mut buf)
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
            crate::db::save_enc_key_manager(&read_pool, &buf).await?;
            state
        }
    };

    // Load or create KeyRegistryState.
    let kr_state: KeyRegistryState<Id> = match crate::db::load_enc_key_registry(&read_pool).await? {
        Some(bytes) => ciborium::from_reader(bytes.as_slice())
            .map_err(|e| EncryptionError::Cbor(e.to_string()))?,
        None => {
            let state = KeyRegistry::<Id>::init();
            let mut buf = Vec::new();
            ciborium::into_writer(&state, &mut buf)
                .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
            crate::db::save_enc_key_registry(&read_pool, &buf).await?;
            state
        }
    };

    ENCRYPTION.set(EncryptionCore {
        key_manager: Mutex::new(km_state),
        key_registry: Mutex::new(kr_state),
        read_pool,
        my_public_key,
    }).ok();
    
    Ok(())
}

#[cfg(test)]
mod encryption_core_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn encryption_core_init() {
        let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let privkey = p2panda_core::PrivateKey::new();
        init_encryption(privkey.to_hex(), pool).await.unwrap();
        assert!(get_encryption().is_some());
    }

    #[tokio::test]
    async fn register_longterm_bundle_round_trip() {
        use p2panda_encryption::key_manager::KeyManager;
        use p2panda_encryption::key_registry::KeyRegistry;
        use p2panda_encryption::traits::{PreKeyManager, PreKeyRegistry};
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let privkey = p2panda_core::PrivateKey::new();
        init_encryption(privkey.to_hex(), pool.clone()).await.unwrap();

        let enc = get_encryption().unwrap();
        // Get our own bundle.
        let km = enc.key_manager.lock().await;
        let bundle = KeyManager::prekey_bundle(&km).unwrap();
        drop(km);

        // Register it for a dummy peer identity (using our own key for simplicity).
        let peer_id = Id(privkey.public_key());
        let kr = enc.key_registry.lock().await.clone();
        let new_kr = KeyRegistry::add_longterm_bundle(kr, peer_id, bundle).unwrap();

        // Retrieve it back.
        let (_, retrieved): (_, Option<p2panda_encryption::key_bundle::LongTermKeyBundle>) = KeyRegistry::<Id>::key_bundle(new_kr, &peer_id).unwrap();
        assert!(retrieved.is_some(), "bundle should be retrievable after registration");
    }
}

// ─── Task 9: Room encryption helpers — envelope + tests scaffold ─────────────

/// Envelope written as the p2panda op body for encrypted messages.
#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptedBody {
    pub secret_id:  GroupSecretId,
    pub nonce:      [u8; 24],      // XAeadNonce is [u8; 24]
    pub ciphertext: Vec<u8>,
    pub sender_key: [u8; 32],      // sender's Ed25519 public key bytes
}

/// Inner implementation that takes an explicit pool (needed for tests with in-memory DBs).
pub(crate) async fn encrypt_for_room_with_pool(
    room_id: &str,
    plaintext: &[u8],
    pool: &SqlitePool,
) -> Result<Vec<u8>, EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;

    // Load CBOR group state from DB.
    let state_bytes = crate::db::load_enc_group_state(pool, room_id)
        .await?
        .ok_or_else(|| EncryptionError::Init(format!("no group state for room '{}'", room_id)))?;

    // Deserialize snapshot → live GroupState.
    let snapshot: DeltaGroupSnapshot = ciborium::from_reader(state_bytes.as_slice())
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    let group_state = snapshot.into_group_state();

    // Encrypt the plaintext.
    let rng = p2panda_encryption::crypto::Rng::default();
    let (new_group_state, msg) = EncryptionGroup::send(group_state, plaintext, &rng)
        .map_err(|e| EncryptionError::Init(format!("{:?}", e)))?;

    // Extract Application fields from the message.
    let (group_secret_id, nonce, ciphertext) = match &msg.content {
        DeltaMessageContent::Application { group_secret_id, nonce, ciphertext } => {
            (*group_secret_id, *nonce, ciphertext.clone())
        }
        _ => return Err(EncryptionError::Init("send produced non-application message".into())),
    };

    // Capture updated km/kr before consuming new_group_state.
    let updated_km = new_group_state.dcgka.my_keys.clone();
    let updated_kr = new_group_state.dcgka.pki.clone();

    // Persist new GroupState snapshot.
    let new_snapshot = DeltaGroupSnapshot::from_group_state(new_group_state);
    let mut new_state_bytes = Vec::new();
    ciborium::into_writer(&new_snapshot, &mut new_state_bytes)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_group_state(pool, room_id, "room", &new_state_bytes).await?;

    // Write updated km/kr back to singleton and DB.
    {
        let mut km = enc.key_manager.lock().await;
        *km = updated_km.clone();
    }
    {
        let mut kr = enc.key_registry.lock().await;
        *kr = updated_kr.clone();
    }
    let mut km_buf = Vec::new();
    ciborium::into_writer(&updated_km, &mut km_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_key_manager(pool, &km_buf).await?;
    let mut kr_buf = Vec::new();
    ciborium::into_writer(&updated_kr, &mut kr_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_key_registry(pool, &kr_buf).await?;

    // Build sender_key from our public key.
    let sender_key: [u8; 32] = *enc.my_public_key.as_bytes();

    // Serialize EncryptedBody.
    let body = EncryptedBody {
        secret_id: group_secret_id,
        nonce,
        ciphertext,
        sender_key,
    };
    let mut body_bytes = Vec::new();
    ciborium::into_writer(&body, &mut body_bytes)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    Ok(body_bytes)
}

/// Encrypt `plaintext` for a room. Returns CBOR-encoded `EncryptedBody`.
pub async fn encrypt_for_room(room_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, EncryptionError> {
    let core = crate::store::get_core().ok_or(EncryptionError::NotInitialised)?;
    encrypt_for_room_with_pool(room_id, plaintext, &core.read_pool).await
}

/// Inner implementation that takes an explicit pool (needed for tests with in-memory DBs).
pub(crate) async fn decrypt_for_room_with_pool(
    room_id: &str,
    body_bytes: &[u8],
    pool: &SqlitePool,
) -> Result<Vec<u8>, EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;

    // Load CBOR group state from DB.
    let state_bytes = crate::db::load_enc_group_state(pool, room_id)
        .await?
        .ok_or_else(|| EncryptionError::Init(format!("no group state for room '{}'", room_id)))?;

    // Deserialize snapshot → live GroupState.
    let snapshot: DeltaGroupSnapshot = ciborium::from_reader(state_bytes.as_slice())
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    let group_state = snapshot.into_group_state();

    // Deserialize EncryptedBody.
    let body: EncryptedBody = ciborium::from_reader(body_bytes)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    // Reconstruct sender PublicKey and build a DeltaMessage.
    let sender_pk = p2panda_core::PublicKey::try_from(body.sender_key.as_slice())
        .map_err(|e| EncryptionError::Init(format!("invalid sender key: {:?}", e)))?;
    let sender_id = Id(sender_pk);

    // Generate a unique message id for this application message.
    let msg_id = OpId(p2panda_core::Hash::new(&body.ciphertext));

    let msg = DeltaMessage {
        id: msg_id,
        sender: sender_id,
        content: DeltaMessageContent::Application {
            group_secret_id: body.secret_id,
            nonce: body.nonce,
            ciphertext: body.ciphertext,
        },
    };

    // Process via receive to decrypt.
    let (new_group_state, outputs) = EncryptionGroup::receive(group_state, &msg)
        .map_err(|e| EncryptionError::Init(format!("{:?}", e)))?;

    // Capture updated km/kr before consuming new_group_state.
    let updated_km = new_group_state.dcgka.my_keys.clone();
    let updated_kr = new_group_state.dcgka.pki.clone();

    // Persist new GroupState snapshot.
    let new_snapshot = DeltaGroupSnapshot::from_group_state(new_group_state);
    let mut new_state_bytes = Vec::new();
    ciborium::into_writer(&new_snapshot, &mut new_state_bytes)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_group_state(pool, room_id, "room", &new_state_bytes).await?;

    // Write updated km/kr back to singleton and DB.
    {
        let mut km = enc.key_manager.lock().await;
        *km = updated_km.clone();
    }
    {
        let mut kr = enc.key_registry.lock().await;
        *kr = updated_kr.clone();
    }
    let mut km_buf = Vec::new();
    ciborium::into_writer(&updated_km, &mut km_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_key_manager(pool, &km_buf).await?;
    let mut kr_buf = Vec::new();
    ciborium::into_writer(&updated_kr, &mut kr_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_key_registry(pool, &kr_buf).await?;

    // Find the Application output and return its plaintext.
    for output in outputs {
        if let p2panda_encryption::data_scheme::GroupOutput::Application { plaintext } = output {
            return Ok(plaintext);
        }
    }

    Err(EncryptionError::Init("no application output from receive — message may not have been decryptable".into()))
}

/// Decrypt a CBOR-encoded `EncryptedBody` for a room. Returns plaintext.
pub async fn decrypt_for_room(room_id: &str, body_bytes: &[u8]) -> Result<Vec<u8>, EncryptionError> {
    let core = crate::store::get_core().ok_or(EncryptionError::NotInitialised)?;
    decrypt_for_room_with_pool(room_id, body_bytes, &core.read_pool).await
}

// ─── Task 10 / Phase 7 Task 5: init_room_group — real GroupState::create ─────

use p2panda_encryption::data_scheme::EncryptionGroup;
use p2panda_encryption::two_party::TwoPartyState;
use p2panda_encryption::key_bundle::LongTermKeyBundle;

/// Serializable snapshot of a `DeltaGroupState`.
///
/// `GroupState<..., KeyRegistry<Id>, ..., KeyManager, ...>` cannot implement `Serialize` because
/// the serde derive adds `KeyRegistry<Id>: Serialize` / `KeyManager: Serialize` bounds, and those
/// marker structs don't implement `Serialize`. We work around that by pulling out all the
/// concrete, serializable state fields manually.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeltaGroupSnapshot {
    pub my_id: Id,
    // DcgkaState fields (concrete state types, not marker types)
    pub pki: p2panda_encryption::key_registry::KeyRegistryState<Id>,
    pub my_keys: p2panda_encryption::key_manager::KeyManagerState,
    pub two_party: std::collections::HashMap<Id, TwoPartyState<LongTermKeyBundle>>,
    pub dgm: DeltaDgmState,
    // Orderer state
    pub orderer: DeltaOrderingState,
    // Secret bundle
    pub secrets: p2panda_encryption::data_scheme::SecretBundleState,
    pub is_welcomed: bool,
}

impl DeltaGroupSnapshot {
    fn from_group_state(y: DeltaGroupState) -> Self {
        DeltaGroupSnapshot {
            my_id: y.my_id,
            pki: y.dcgka.pki,
            my_keys: y.dcgka.my_keys,
            two_party: y.dcgka.two_party,
            dgm: y.dcgka.dgm,
            orderer: y.orderer,
            secrets: y.secrets,
            is_welcomed: y.is_welcomed,
        }
    }

    /// Reconstruct a live `DeltaGroupState` from this snapshot.
    ///
    /// All concrete state fields are stored in the snapshot, so we can rebuild the full
    /// `GroupState` struct directly — bypassing `EncryptionGroup::init` which would reset
    /// `secrets` and `is_welcomed` to their initial values.
    pub fn into_group_state(self) -> DeltaGroupState {
        use p2panda_encryption::data_scheme::dcgka::DcgkaState;
        DeltaGroupState {
            my_id: self.my_id,
            dcgka: DcgkaState {
                my_id: self.my_id,
                my_keys: self.my_keys,
                pki: self.pki,
                two_party: self.two_party,
                dgm: self.dgm,
            },
            orderer: self.orderer,
            secrets: self.secrets,
            is_welcomed: self.is_welcomed,
        }
    }
}

/// Inner implementation that takes an explicit pool (needed for tests with in-memory DBs).
pub(crate) async fn init_room_group_with_pool(
    room_id: &str,
    initial_members: Vec<PublicKey>,
    pool: &SqlitePool,
) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), EncryptionError> {
    let enc = get_encryption().ok_or(EncryptionError::NotInitialised)?;

    // Clone state out of the mutexes (we work on owned copies).
    let km_state = enc.key_manager.lock().await.clone();
    let kr_state = enc.key_registry.lock().await.clone();

    let my_id = Id(enc.my_public_key);
    let all_ids: Vec<Id> = initial_members.iter().map(|pk| Id(*pk)).collect();

    // Build DGM state (empty — create() will populate it inside EncryptionGroup::create).
    let dgm_state = DeltaDgm::create(my_id, &[])
        .map_err(|e| EncryptionError::Init(e.to_string()))?;

    // Build ordering state.
    let ord_state = DeltaOrdering::init(enc.my_public_key);

    // Assemble the GroupState.
    let group_state: DeltaGroupState = EncryptionGroup::init(
        my_id,
        km_state,
        kr_state,
        dgm_state,
        ord_state,
    );

    // Create the group, producing a new GroupState and a control message.
    let rng = p2panda_encryption::crypto::Rng::default();
    let (new_group_state, ctrl_msg) = EncryptionGroup::create(group_state, all_ids, &rng)
        .map_err(|e| EncryptionError::Init(format!("{:?}", e)))?;

    // Extract updated km/kr states BEFORE consuming new_group_state into the snapshot.
    // GroupState::create consumes pre-keys internally; the singleton must reflect that.
    let updated_km = new_group_state.dcgka.my_keys.clone();
    let updated_kr = new_group_state.dcgka.pki.clone();

    // Persist the new GroupState via the serializable snapshot.
    let snapshot = DeltaGroupSnapshot::from_group_state(new_group_state);
    let mut state_bytes = Vec::new();
    ciborium::into_writer(&snapshot, &mut state_bytes)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_group_state(pool, room_id, "room", &state_bytes).await?;

    // Write updated km/kr states back to the EncryptionCore singleton.
    // GroupState::create consumes pre-keys internally; the singleton must reflect that.
    {
        let mut km = enc.key_manager.lock().await;
        *km = updated_km.clone();
    }
    {
        let mut kr = enc.key_registry.lock().await;
        *kr = updated_kr.clone();
    }

    // Persist updated key manager state so the consumed pre-keys are reflected on next boot.
    let mut km_buf = Vec::new();
    ciborium::into_writer(&updated_km, &mut km_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_key_manager(pool, &km_buf).await?;

    let mut kr_buf = Vec::new();
    ciborium::into_writer(&updated_kr, &mut kr_buf)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
    crate::db::save_enc_key_registry(pool, &kr_buf).await?;

    // Serialize the ctrl message so callers can publish it.
    let mut ctrl_bytes = Vec::new();
    ciborium::into_writer(&ctrl_msg, &mut ctrl_bytes)
        .map_err(|e| EncryptionError::Cbor(e.to_string()))?;

    // Extract per-recipient direct messages from the ctrl message content.
    let directs_vec: Vec<(String, Vec<u8>)> = match &ctrl_msg.content {
        DeltaMessageContent::Control { directs, .. } => {
            let mut out = Vec::new();
            for dm in directs {
                let recipient_hex = hex::encode(dm.recipient.0.as_bytes());
                let mut dm_bytes = Vec::new();
                ciborium::into_writer(dm, &mut dm_bytes)
                    .map_err(|e| EncryptionError::Cbor(e.to_string()))?;
                out.push((recipient_hex, dm_bytes));
            }
            out
        }
        _ => vec![],
    };

    Ok((ctrl_bytes, directs_vec))
}

/// Create a new DCGKA encryption group for a room.
/// Returns (EncCtrlOp bytes, Vec<(recipient_hex, EncDirectOp bytes)>).
pub async fn init_room_group(
    room_id: &str,
    initial_members: Vec<PublicKey>,
) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), EncryptionError> {
    let core = crate::store::get_core().ok_or(EncryptionError::NotInitialised)?;
    init_room_group_with_pool(room_id, initial_members, &core.read_pool).await
}

#[cfg(test)]
mod room_encrypt_tests {
    use super::*;

    #[tokio::test]
    async fn init_room_group_creates_group_state() {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let privkey = p2panda_core::PrivateKey::new();
        let _ = init_encryption(privkey.to_hex(), pool.clone()).await;

        // Use the ACTUAL key from the singleton (may differ from privkey if singleton was already set).
        let enc = get_encryption().expect("EncryptionCore must be initialized");
        let my_pk = enc.my_public_key;

        let result = init_room_group_with_pool(
            "room-test-001",
            vec![my_pk],
            &pool,
        )
        .await;
        assert!(
            result.is_ok(),
            "init_room_group should succeed: {:?}",
            result.err()
        );

        let stored = crate::db::load_enc_group_state(&pool, "room-test-001")
            .await
            .unwrap();
        assert!(stored.is_some(), "group state should be saved to DB");

        // Verify round-trip: snapshot must deserialize and reconstruct a live GroupState.
        let bytes = stored.unwrap();
        let snap: DeltaGroupSnapshot = ciborium::from_reader(bytes.as_slice())
            .expect("stored snapshot must deserialize cleanly");
        let _reconstructed = snap.into_group_state();
        // If this doesn't panic, the round-trip works.
    }

    #[test]
    fn room_encrypt_decrypt_roundtrip() {
        use p2panda_encryption::data_scheme::{encrypt_data, decrypt_data, group_secret::SecretBundle};
        use p2panda_encryption::crypto::{Rng, xchacha20::XAeadNonce};

        let rng = Rng::default();
        let state = SecretBundle::init();
        let group_secret = SecretBundle::generate(&state, &rng).unwrap();
        let nonce: XAeadNonce = rng.random_array().unwrap();
        let plaintext = b"hello encrypted world";
        let ciphertext = encrypt_data(plaintext, &group_secret, nonce).unwrap();
        let decrypted = decrypt_data(&ciphertext, &group_secret, nonce).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[tokio::test]
    async fn encrypt_decrypt_for_room_roundtrip() {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();

        // Use singleton's actual key (OnceLock race prevention).
        let privkey = p2panda_core::PrivateKey::new();
        let _ = init_encryption(privkey.to_hex(), pool.clone()).await;
        let enc = get_encryption().expect("EncryptionCore must be initialized");
        let my_pk = enc.my_public_key;
        drop(enc);

        // Create the room group first (required before encrypt/decrypt).
        init_room_group_with_pool("test-room-enc", vec![my_pk], &pool)
            .await
            .expect("init_room_group should succeed");

        let plaintext = b"hello encrypted blob";

        // Encrypt.
        let enc_bytes = encrypt_for_room_with_pool("test-room-enc", plaintext, &pool)
            .await
            .expect("encrypt should succeed");

        // Decrypt.
        let recovered = decrypt_for_room_with_pool("test-room-enc", &enc_bytes, &pool)
            .await
            .expect("decrypt should return plaintext");

        assert_eq!(recovered, plaintext, "decrypted plaintext should match original");
    }
}

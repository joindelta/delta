//! Phase 5 — Membership & Authorization
//!
//! Integrates p2panda-auth for DAG-based group membership with access levels.
//! Provides invite token generation and verification.

use p2panda_core::{PrivateKey, PublicKey, Hash};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use std::collections::HashMap;
use base64::{Engine as _, engine::general_purpose};

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("invalid signature")]
    InvalidSignature,
    #[error("token expired")]
    TokenExpired,
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("auth graph error: {0}")]
    GraphError(String),
    #[error("serialization error: {0}")]
    Serialization(String),
}

// ─── Access Levels ───────────────────────────────────────────────────────────

/// Delta access levels (hierarchical supersets).
/// Pull → Read → Write → Manage
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AccessLevel {
    Pull,   // Can pull ops, see org exists
    Read,   // Can read all content
    Write,  // Can post messages, create rooms
    Manage, // Can add/remove members, change perms
}

impl AccessLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            AccessLevel::Pull => "pull",
            AccessLevel::Read => "read",
            AccessLevel::Write => "write",
            AccessLevel::Manage => "manage",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pull" => Some(AccessLevel::Pull),
            "read" => Some(AccessLevel::Read),
            "write" => Some(AccessLevel::Write),
            "manage" => Some(AccessLevel::Manage),
            _ => None,
        }
    }

    /// Check if this level has at least the required level.
    pub fn has_permission(&self, required: AccessLevel) -> bool {
        self >= &required
    }
}

// ─── Membership State ────────────────────────────────────────────────────────

/// In-memory membership state for an organization.
#[derive(Debug, Clone)]
pub struct MembershipState {
    pub org_id: String,
    pub members: HashMap<PublicKey, AccessLevel>,
}

impl MembershipState {
    pub fn new(org_id: String) -> Self {
        Self {
            org_id,
            members: HashMap::new(),
        }
    }

    pub fn add_member(&mut self, member_key: PublicKey, level: AccessLevel) {
        self.members.insert(member_key, level);
    }

    pub fn remove_member(&mut self, member_key: &PublicKey) {
        self.members.remove(member_key);
    }

    pub fn change_permission(&mut self, member_key: PublicKey, new_level: AccessLevel) {
        self.members.insert(member_key, new_level);
    }

    pub fn get_level(&self, member_key: &PublicKey) -> Option<AccessLevel> {
        self.members.get(member_key).copied()
    }

    pub fn has_permission(&self, member_key: &PublicKey, required: AccessLevel) -> bool {
        self.get_level(member_key)
            .map(|level| level.has_permission(required))
            .unwrap_or(false)
    }

    pub fn is_member(&self, member_key: &PublicKey) -> bool {
        self.members.contains_key(member_key)
    }
}

// ─── Invite Token ────────────────────────────────────────────────────────────

/// Invite token payload (signed by inviter).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteToken {
    pub org_id: String,
    pub inviter_key: String,      // hex-encoded PublicKey
    pub access_level: String,     // "pull" | "read" | "write" | "manage"
    pub expiry_timestamp: i64,    // Unix timestamp (microseconds)
    pub signature: String,        // hex-encoded Ed25519 signature
}

impl InviteToken {
    /// Create and sign an invite token.
    pub fn create(
        org_id: String,
        inviter_key: PublicKey,
        access_level: AccessLevel,
        expiry_timestamp: i64,
        private_key: &PrivateKey,
    ) -> Self {
        let inviter_key_hex = inviter_key.to_hex();
        let access_level_str = access_level.as_str().to_string();

        // Create payload to sign
        let payload = format!(
            "{}:{}:{}:{}",
            org_id, inviter_key_hex, access_level_str, expiry_timestamp
        );

        // Sign with Ed25519
        let signature_bytes = private_key.sign(payload.as_bytes());
        let signature = hex::encode(signature_bytes.to_bytes());

        Self {
            org_id,
            inviter_key: inviter_key_hex,
            access_level: access_level_str,
            expiry_timestamp,
            signature,
        }
    }

    /// Verify token signature and expiry.
    pub fn verify(&self, current_timestamp: i64) -> Result<(PublicKey, AccessLevel), AuthError> {
        // Check expiry
        if current_timestamp > self.expiry_timestamp {
            return Err(AuthError::TokenExpired);
        }

        // Parse inviter public key
        let inviter_key_bytes = hex::decode(&self.inviter_key)
            .map_err(|_| AuthError::InvalidSignature)?;
        let inviter_key_array: [u8; 32] = inviter_key_bytes.as_slice().try_into()
            .map_err(|_| AuthError::InvalidSignature)?;
        let inviter_key = PublicKey::from_bytes(&inviter_key_array)
            .map_err(|_| AuthError::InvalidSignature)?;

        // Parse access level
        let access_level = AccessLevel::from_str(&self.access_level)
            .ok_or(AuthError::InvalidSignature)?;

        // Reconstruct payload
        let payload = format!(
            "{}:{}:{}:{}",
            self.org_id, self.inviter_key, self.access_level, self.expiry_timestamp
        );

        // Decode signature
        let signature_bytes = hex::decode(&self.signature)
            .map_err(|_| AuthError::InvalidSignature)?;
        let signature = p2panda_core::Signature::try_from(signature_bytes.as_slice())
            .map_err(|_| AuthError::InvalidSignature)?;

        // Verify signature
        if !inviter_key.verify(payload.as_bytes(), &signature) {
            return Err(AuthError::InvalidSignature);
        }

        Ok((inviter_key, access_level))
    }

    /// Encode token as base64 for sharing (QR code, deep link).
    pub fn to_base64(&self) -> Result<String, AuthError> {
        let json = serde_json::to_string(self)
            .map_err(|e| AuthError::Serialization(e.to_string()))?;
        Ok(general_purpose::STANDARD.encode(json.as_bytes()))
    }

    /// Decode token from base64.
    pub fn from_base64(encoded: &str) -> Result<Self, AuthError> {
        let json_bytes = general_purpose::STANDARD.decode(encoded)
            .map_err(|e| AuthError::Serialization(e.to_string()))?;
        let json = String::from_utf8(json_bytes)
            .map_err(|e| AuthError::Serialization(e.to_string()))?;
        serde_json::from_str(&json)
            .map_err(|e| AuthError::Serialization(e.to_string()))
    }
}

// ─── Membership Operations ───────────────────────────────────────────────────

/// Add a member to an organization.
/// Returns the operation hash for publishing.
pub async fn add_member(
    state: &mut MembershipState,
    adder_key: &PublicKey,
    new_member_key: PublicKey,
    access_level: AccessLevel,
) -> Result<Hash, AuthError> {
    // Check if adder has Manage permission
    if !state.has_permission(adder_key, AccessLevel::Manage) {
        return Err(AuthError::Unauthorized(
            "only Manage-level members can add members".into(),
        ));
    }

    // Add member to state
    state.add_member(new_member_key, access_level);

    // Create operation data
    let op_data = format!("add:{}:{}", new_member_key.to_hex(), access_level.as_str());
    Ok(Hash::new(op_data.as_bytes()))
}

/// Remove a member from an organization.
/// Returns the operation hash for publishing.
pub async fn remove_member(
    state: &mut MembershipState,
    remover_key: &PublicKey,
    member_to_remove: &PublicKey,
) -> Result<Hash, AuthError> {
    // Check if remover has Manage permission
    if !state.has_permission(remover_key, AccessLevel::Manage) {
        return Err(AuthError::Unauthorized(
            "only Manage-level members can remove members".into(),
        ));
    }

    // Cannot remove yourself
    if remover_key == member_to_remove {
        return Err(AuthError::Unauthorized(
            "cannot remove yourself".into(),
        ));
    }

    // Remove member from state
    state.remove_member(member_to_remove);

    // Create operation data
    let op_data = format!("remove:{}", member_to_remove.to_hex());
    Ok(Hash::new(op_data.as_bytes()))
}

/// Change a member's access level.
/// Returns the operation hash for publishing.
pub async fn change_permission(
    state: &mut MembershipState,
    changer_key: &PublicKey,
    target_member: PublicKey,
    new_level: AccessLevel,
) -> Result<Hash, AuthError> {
    // Check if changer has Manage permission
    if !state.has_permission(changer_key, AccessLevel::Manage) {
        return Err(AuthError::Unauthorized(
            "only Manage-level members can change permissions".into(),
        ));
    }

    // Update permission
    state.change_permission(target_member, new_level);

    // Create operation data
    let op_data = format!("change:{}:{}", target_member.to_hex(), new_level.as_str());
    Ok(Hash::new(op_data.as_bytes()))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> (PrivateKey, PublicKey) {
        let pk = PrivateKey::new();
        let pubkey = pk.public_key();
        (pk, pubkey)
    }

    #[test]
    fn access_level_hierarchy() {
        assert!(AccessLevel::Manage.has_permission(AccessLevel::Pull));
        assert!(AccessLevel::Manage.has_permission(AccessLevel::Read));
        assert!(AccessLevel::Manage.has_permission(AccessLevel::Write));
        assert!(AccessLevel::Manage.has_permission(AccessLevel::Manage));

        assert!(AccessLevel::Write.has_permission(AccessLevel::Pull));
        assert!(AccessLevel::Write.has_permission(AccessLevel::Read));
        assert!(AccessLevel::Write.has_permission(AccessLevel::Write));
        assert!(!AccessLevel::Write.has_permission(AccessLevel::Manage));

        assert!(!AccessLevel::Pull.has_permission(AccessLevel::Read));
    }

    #[test]
    fn membership_state_operations() {
        let (_, admin_key) = test_key();
        let (_, member_key) = test_key();

        let mut state = MembershipState::new("org1".into());
        state.add_member(admin_key, AccessLevel::Manage);

        assert!(state.is_member(&admin_key));
        assert!(!state.is_member(&member_key));
        assert_eq!(state.get_level(&admin_key), Some(AccessLevel::Manage));

        state.add_member(member_key, AccessLevel::Read);
        assert!(state.is_member(&member_key));
        assert_eq!(state.get_level(&member_key), Some(AccessLevel::Read));

        state.change_permission(member_key, AccessLevel::Write);
        assert_eq!(state.get_level(&member_key), Some(AccessLevel::Write));

        state.remove_member(&member_key);
        assert!(!state.is_member(&member_key));
    }

    #[tokio::test]
    async fn add_member_requires_manage_permission() {
        let (_, admin_key) = test_key();
        let (_, writer_key) = test_key();
        let (_, new_member_key) = test_key();

        let mut state = MembershipState::new("org1".into());
        state.add_member(admin_key, AccessLevel::Manage);
        state.add_member(writer_key, AccessLevel::Write);

        // Admin can add
        let result = add_member(&mut state, &admin_key, new_member_key, AccessLevel::Read).await;
        assert!(result.is_ok());

        // Writer cannot add
        let (_, another_key) = test_key();
        let result = add_member(&mut state, &writer_key, another_key, AccessLevel::Read).await;
        assert!(result.is_err());
    }

    #[test]
    fn invite_token_create_and_verify() {
        let (private_key, public_key) = test_key();
        let expiry = 9999999999999999; // Far future

        let token = InviteToken::create(
            "org1".into(),
            public_key,
            AccessLevel::Write,
            expiry,
            &private_key,
        );

        let current_time = 1000000000000000;
        let result = token.verify(current_time);
        assert!(result.is_ok());

        let (verified_key, verified_level) = result.unwrap();
        assert_eq!(verified_key, public_key);
        assert_eq!(verified_level, AccessLevel::Write);
    }

    #[test]
    fn invite_token_rejects_expired() {
        let (private_key, public_key) = test_key();
        let expiry = 1000000000000000;

        let token = InviteToken::create(
            "org1".into(),
            public_key,
            AccessLevel::Write,
            expiry,
            &private_key,
        );

        let current_time = 2000000000000000; // After expiry
        let result = token.verify(current_time);
        assert!(matches!(result, Err(AuthError::TokenExpired)));
    }

    #[test]
    fn invite_token_rejects_invalid_signature() {
        let (private_key, public_key) = test_key();
        let (_, other_key) = test_key();
        let expiry = 9999999999999999;

        let mut token = InviteToken::create(
            "org1".into(),
            public_key,
            AccessLevel::Write,
            expiry,
            &private_key,
        );

        // Tamper with the token
        token.access_level = "manage".into();

        let current_time = 1000000000000000;
        let result = token.verify(current_time);
        assert!(matches!(result, Err(AuthError::InvalidSignature)));
    }

    #[test]
    fn invite_token_base64_roundtrip() {
        let (private_key, public_key) = test_key();
        let expiry = 9999999999999999;

        let token = InviteToken::create(
            "org1".into(),
            public_key,
            AccessLevel::Write,
            expiry,
            &private_key,
        );

        let encoded = token.to_base64().unwrap();
        let decoded = InviteToken::from_base64(&encoded).unwrap();

        assert_eq!(decoded.org_id, token.org_id);
        assert_eq!(decoded.inviter_key, token.inviter_key);
        assert_eq!(decoded.access_level, token.access_level);
        assert_eq!(decoded.expiry_timestamp, token.expiry_timestamp);
        assert_eq!(decoded.signature, token.signature);
    }

    #[tokio::test]
    async fn cannot_remove_yourself() {
        let (_, admin_key) = test_key();

        let mut state = MembershipState::new("org1".into());
        state.add_member(admin_key, AccessLevel::Manage);

        let result = remove_member(&mut state, &admin_key, &admin_key).await;
        assert!(result.is_err());
    }
}

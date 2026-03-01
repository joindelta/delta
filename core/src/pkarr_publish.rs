//! pkarr publishing — publish signed DNS TXT records to the mainline BitTorrent DHT.
//!
//! Users and orgs can opt-in to public profiles. When enabled, their profile data
//! is published as signed DNS records that anyone can resolve by public key.

use std::time::Duration;

use pkarr::{Keypair, SignedPacket};
use sqlx::{Row, SqlitePool};
use tokio::time::interval;

use crate::store::get_core;

const PKARR_REPUBLISH_INTERVAL_SECS: u64 = 3000; // 50 minutes
const DNS_TTL: u32 = 7200; // 2 hours

/// Get the pkarr URL for a public key.
/// Returns: `pk:<z32-encoded-pubkey>`
pub fn get_pkarr_url(public_key_hex: &str) -> Result<String, String> {
    let pk_bytes = hex::decode(public_key_hex).map_err(|e| format!("invalid hex: {}", e))?;
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into()
        .map_err(|_| "invalid key length".to_string())?;
    let public_key = pkarr::PublicKey::try_from(&pk_arr)
        .map_err(|e| format!("invalid public key: {}", e))?;
    Ok(format!("pk:{}", public_key.to_z32()))
}

/// Extract z32-encoded public key from a pkarr URL.
/// Input: `pk:yj4bqhvahk8dge...`
/// Output: `yj4bqhvahk8dge...`
pub fn parse_pkarr_url(url: &str) -> Option<String> {
    url.strip_prefix("pk:").map(|s| s.to_string())
}

/// Build a DNS TXT record for a user profile.
/// Format: `v=delta1;t=user;u=<username>;b=<bio>;a=<avatar_blob_id>`
fn build_user_txt_record(
    username: &str,
    bio: Option<&str>,
    avatar_blob_id: Option<&str>,
) -> String {
    let mut parts = vec![
        "v=delta1".to_string(),
        "t=user".to_string(),
        format!("u={}", username),
    ];
    
    if let Some(bio_str) = bio {
        if !bio_str.is_empty() {
            // Truncate bio to stay within packet limits
            let truncated = if bio_str.len() > 100 {
                format!("{}...", &bio_str[..97])
            } else {
                bio_str.to_string()
            };
            parts.push(format!("b={}", truncated));
        }
    }
    
    if let Some(avatar) = avatar_blob_id {
        parts.push(format!("a={}", avatar));
    }
    
    parts.join(";")
}

/// Build a DNS TXT record for an org profile.
/// Format: `v=delta1;t=org;n=<name>;d=<description>;a=<avatar_blob_id>;c=<cover_blob_id>`
fn build_org_txt_record(
    name: &str,
    description: Option<&str>,
    avatar_blob_id: Option<&str>,
    cover_blob_id: Option<&str>,
) -> String {
    let mut parts = vec![
        "v=delta1".to_string(),
        "t=org".to_string(),
        format!("n={}", name),
    ];
    
    if let Some(desc) = description {
        if !desc.is_empty() {
            // Truncate description to stay within packet limits
            let truncated = if desc.len() > 150 {
                format!("{}...", &desc[..147])
            } else {
                desc.to_string()
            };
            parts.push(format!("d={}", truncated));
        }
    }
    
    if let Some(avatar) = avatar_blob_id {
        parts.push(format!("a={}", avatar));
    }
    
    if let Some(cover) = cover_blob_id {
        parts.push(format!("c={}", cover));
    }
    
    parts.join(";")
}

/// Publish a user profile to the pkarr DHT.
pub async fn publish_profile(
    private_key_hex: &str,
    username: &str,
    bio: Option<&str>,
    avatar_blob_id: Option<&str>,
) -> Result<(), String> {
    let pk_bytes = hex::decode(private_key_hex).map_err(|e| format!("invalid hex: {}", e))?;
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into()
        .map_err(|_| "invalid key length".to_string())?;
    
    let keypair = Keypair::from_secret_key(&pk_arr);
    
    let txt_value = build_user_txt_record(username, bio, avatar_blob_id);

    let txt = pkarr::dns::rdata::TXT::try_from(txt_value.as_str())
        .map_err(|e| format!("invalid txt: {}", e))?;
    let name = pkarr::dns::Name::new("_delta")
        .map_err(|e| format!("invalid name: {}", e))?;
    let signed_packet = SignedPacket::builder()
        .txt(name, txt, DNS_TTL)
        .sign(&keypair)
        .map_err(|e| format!("failed to sign packet: {}", e))?;

    let client = pkarr::Client::builder()
        .build()
        .map_err(|e| format!("failed to create pkarr client: {}", e))?;

    // Publish fire-and-forget
    let pk_z32 = keypair.to_z32();
    tokio::spawn(async move {
        if let Err(e) = client.publish(&signed_packet, None).await {
            eprintln!("[pkarr] failed to publish profile: {}", e);
        } else {
            println!("[pkarr] published profile for {}", pk_z32);
        }
    });
    
    Ok(())
}

/// Publish an org profile to the pkarr DHT.
pub async fn publish_org(
    private_key_hex: &str,
    org_id: &str,
    name: &str,
    description: Option<&str>,
    avatar_blob_id: Option<&str>,
    cover_blob_id: Option<&str>,
) -> Result<(), String> {
    let pk_bytes = hex::decode(private_key_hex).map_err(|e| format!("invalid hex: {}", e))?;
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into()
        .map_err(|_| "invalid key length".to_string())?;
    
    let keypair = Keypair::from_secret_key(&pk_arr);
    
    let txt_value = build_org_txt_record(name, description, avatar_blob_id, cover_blob_id);

    let txt = pkarr::dns::rdata::TXT::try_from(txt_value.as_str())
        .map_err(|e| format!("invalid txt: {}", e))?;
    let rec_name = pkarr::dns::Name::new("_delta")
        .map_err(|e| format!("invalid name: {}", e))?;
    let signed_packet = SignedPacket::builder()
        .txt(rec_name, txt, DNS_TTL)
        .sign(&keypair)
        .map_err(|e| format!("failed to sign packet: {}", e))?;

    let client = pkarr::Client::builder()
        .build()
        .map_err(|e| format!("failed to create pkarr client: {}", e))?;

    // Publish fire-and-forget
    let oid = org_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = client.publish(&signed_packet, None).await {
            eprintln!("[pkarr] failed to publish org: {}", e);
        } else {
            println!("[pkarr] published org {}", oid);
        }
    });
    
    Ok(())
}

/// Publish a tombstone record (empty TXT) to signal profile removal.
pub async fn publish_tombstone(private_key_hex: &str) -> Result<(), String> {
    let pk_bytes = hex::decode(private_key_hex).map_err(|e| format!("invalid hex: {}", e))?;
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into()
        .map_err(|_| "invalid key length".to_string())?;
    
    let keypair = Keypair::from_secret_key(&pk_arr);
    
    let txt = pkarr::dns::rdata::TXT::try_from("v=delta1;t=none")
        .map_err(|e| format!("invalid txt: {}", e))?;
    let name = pkarr::dns::Name::new("_delta")
        .map_err(|e| format!("invalid name: {}", e))?;
    let signed_packet = SignedPacket::builder()
        .txt(name, txt, 60) // Short TTL for tombstone
        .sign(&keypair)
        .map_err(|e| format!("failed to sign packet: {}", e))?;

    let client = pkarr::Client::builder()
        .build()
        .map_err(|e| format!("failed to create pkarr client: {}", e))?;
    
    tokio::spawn(async move {
        if let Err(e) = client.publish(&signed_packet, None).await {
            eprintln!("[pkarr] failed to publish tombstone: {}", e);
        }
    });
    
    Ok(())
}

/// Resolved record from pkarr DHT.
#[derive(Debug, Clone)]
pub struct PkarrResolvedRecord {
    pub record_type: String, // "user" | "org" | "none"
    pub name: Option<String>,
    pub username: Option<String>, // for user profiles
    pub description: Option<String>,
    pub bio: Option<String>, // for user profiles
    pub avatar_blob_id: Option<String>,
    pub cover_blob_id: Option<String>, // for org profiles
    pub public_key: String, // z32-encoded
}

/// Parse a TXT record string into a structured record.
fn parse_txt_record(txt: &str, z32_key: &str) -> Result<PkarrResolvedRecord, String> {
    let mut record = PkarrResolvedRecord {
        record_type: "none".to_string(),
        name: None,
        username: None,
        description: None,
        bio: None,
        avatar_blob_id: None,
        cover_blob_id: None,
        public_key: z32_key.to_string(),
    };
    
    for part in txt.split(';') {
        if let Some((key, value)) = part.split_once('=') {
            match key {
                "t" => record.record_type = value.to_string(),
                "u" => record.username = Some(value.to_string()),
                "n" => record.name = Some(value.to_string()),
                "b" => record.bio = Some(value.to_string()),
                "d" => record.description = Some(value.to_string()),
                "a" => record.avatar_blob_id = Some(value.to_string()),
                "c" => record.cover_blob_id = Some(value.to_string()),
                _ => {}
            }
        }
    }
    
    Ok(record)
}

/// Resolve a pkarr record from the DHT.
/// Input: z32-encoded public key (without `pk:` prefix)
pub async fn resolve_pkarr(z32_key: &str) -> Result<Option<PkarrResolvedRecord>, String> {
    let public_key = pkarr::PublicKey::try_from(z32_key)
        .map_err(|e| format!("invalid z32 key: {}", e))?;
    
    let client = pkarr::Client::builder()
        .build()
        .map_err(|e| format!("failed to create pkarr client: {}", e))?;

    match client.resolve(&public_key).await {
        Some(signed_packet) => {
            // Parse the DNS packet to extract TXT records
            for rr in signed_packet.all_resource_records() {
                if let pkarr::dns::rdata::RData::TXT(txt) = &rr.rdata {
                    if let Ok(txt_str) = String::try_from(txt.clone()) {
                        if txt_str.starts_with("v=delta1") {
                            return Ok(Some(parse_txt_record(&txt_str, z32_key)?));
                        }
                    }
                }
            }
            Ok(None)
        }
        None => Ok(None),
    }
}

/// Start the background republish loop.
/// Republishes all public profiles and orgs every 50 minutes.
pub async fn start_republish_loop(read_pool: SqlitePool) {
    let mut ticker = interval(Duration::from_secs(PKARR_REPUBLISH_INTERVAL_SECS));
    
    loop {
        ticker.tick().await;
        
        if let Err(e) = republish_all(&read_pool).await {
            eprintln!("[pkarr] republish error: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_relay_record() {
        let txt = format!("v=delta1;t=relay;n=https://relay.delta.app/hop;a={}", "ab".repeat(32));
        let record = parse_txt_record(&txt, "testz32key").unwrap();
        assert_eq!(record.record_type, "relay");
        assert_eq!(record.name.as_deref(), Some("https://relay.delta.app/hop"));
        assert_eq!(record.avatar_blob_id.as_deref(), Some(&"ab".repeat(32) as &str));
    }

    #[test]
    fn parse_user_record_still_works() {
        let txt = "v=delta1;t=user;u=alice;b=hello";
        let record = parse_txt_record(txt, "testz32key").unwrap();
        assert_eq!(record.record_type, "user");
        assert_eq!(record.username.as_deref(), Some("alice"));
        assert_eq!(record.bio.as_deref(), Some("hello"));
    }
}

/// Republish all public profiles and orgs.
async fn republish_all(read_pool: &SqlitePool) -> Result<(), String> {
    let Some(core) = get_core() else {
        return Ok(());
    };

    let private_key_hex = core.private_key.to_hex();

    // Get all public profiles
    let rows = sqlx::query(
        "SELECT public_key, username, bio, avatar_blob_id FROM profiles WHERE is_public = 1"
    )
    .fetch_all(read_pool)
    .await
    .map_err(|e| format!("db error: {}", e))?;

    for row in rows {
        let public_key: String = row.get("public_key");
        let username: String = row.get("username");
        let bio: Option<String> = row.get("bio");
        let avatar: Option<String> = row.get("avatar_blob_id");

        if let Err(e) = publish_profile(&private_key_hex, &username, bio.as_deref(), avatar.as_deref()).await {
            eprintln!("[pkarr] failed to republish profile {}: {}", public_key, e);
        }
    }
    
    // Get all public orgs
    let org_rows = sqlx::query(
        "SELECT org_id, name, description, avatar_blob_id, cover_blob_id FROM organizations WHERE is_public = 1"
    )
    .fetch_all(read_pool)
    .await
    .map_err(|e| format!("db error: {}", e))?;
    
    for row in org_rows {
        let org_id: String = row.get("org_id");
        let name: String = row.get("name");
        let description: Option<String> = row.get("description");
        let avatar: Option<String> = row.get("avatar_blob_id");
        let cover: Option<String> = row.get("cover_blob_id");
        
        if let Err(e) = publish_org(&private_key_hex, &org_id, &name, description.as_deref(), avatar.as_deref(), cover.as_deref()).await {
            eprintln!("[pkarr] failed to republish org {}: {}", org_id, e);
        }
    }
    
    println!("[pkarr] republished profiles and orgs");
    
    Ok(())
}

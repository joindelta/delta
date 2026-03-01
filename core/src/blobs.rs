use crate::{db, encryption, store};
use p2panda_core::Hash;
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("Core not initialized")]
    NotInitialized,
    #[error("Blob not found")]
    NotFound,
    #[error("Blob store error: {0}")]
    StoreError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Upload a blob and return its content-hash (hex).
///
/// If `room_id` is `Some`, the blob is encrypted with the room's DCGKA key
/// before writing to disk. Pass `None` for unencrypted blobs (e.g. avatars).
pub fn upload_blob(
    bytes: Vec<u8>,
    mime_type: String,
    room_id: Option<String>,
) -> Result<String, BlobError> {
    crate::store::block_on(upload_blob_async(bytes, mime_type, room_id))
}

async fn upload_blob_async(
    bytes: Vec<u8>,
    mime_type: String,
    room_id: Option<String>,
) -> Result<String, BlobError> {
    let core = store::get_core().ok_or(BlobError::NotInitialized)?;

    // For encrypted blobs the hash mixes in room_id to prevent two different
    // rooms' ciphertexts from colliding on disk.
    let hash_str = match &room_id {
        Some(rid) => Hash::new(&[bytes.as_slice(), rid.as_bytes()].concat()).to_hex(),
        None => Hash::new(&bytes).to_hex(),
    };

    let data_to_write = match &room_id {
        Some(rid) => encryption::encrypt_for_room(rid, &bytes)
            .await
            .map_err(|e| BlobError::StoreError(e.to_string()))?,
        None => bytes,
    };

    // Record metadata first so get_blob knows whether/how to decrypt.
    // If the subsequent file write fails, the DB row can be cleaned up on
    // retry — the schema uses ON CONFLICT DO NOTHING so re-upload is safe.
    let meta = db::BlobMeta {
        blob_hash: hash_str.clone(),
        mime_type,
        room_id: room_id.clone(),
        sender_key: None,
        secret_id: None,
        nonce: None,
    };
    db::insert_blob_meta(&core.read_pool, &meta)
        .await
        .map_err(|e| BlobError::StoreError(e.to_string()))?;

    // Write bytes to the blob store directory.
    let blob_path = core.blob_store.join(&hash_str);
    fs::write(&blob_path, &data_to_write).await?;

    Ok(hash_str)
}

/// Retrieve a blob by its hash, decrypting if necessary.
pub fn get_blob(hash_str: String) -> Result<Vec<u8>, BlobError> {
    crate::store::block_on(get_blob_async(hash_str))
}

async fn get_blob_async(hash_str: String) -> Result<Vec<u8>, BlobError> {
    let core = store::get_core().ok_or(BlobError::NotInitialized)?;

    let blob_path = core.blob_store.join(&hash_str);
    let file_bytes = fs::read(&blob_path).await?;

    // Look up metadata.
    let meta = db::get_blob_meta(&core.read_pool, &hash_str)
        .await
        .map_err(|e| BlobError::StoreError(e.to_string()))?
        .ok_or(BlobError::NotFound)?;

    // A blob is encrypted if it has an associated room_id.
    if let Some(room_id) = meta.room_id {
        encryption::decrypt_for_room(&room_id, &file_bytes)
            .await
            .map_err(|e| BlobError::StoreError(e.to_string()))
    } else {
        Ok(file_bytes)
    }
}

/// Returns the blob store directory for the given db_dir.
pub fn blob_store_path(db_dir: &str) -> PathBuf {
    PathBuf::from(db_dir).join("blobs")
}

#[cfg(test)]
mod tests {
    #[test]
    fn blob_hash_is_deterministic() {
        use p2panda_core::Hash;
        let data = b"test blob content";
        let h1 = Hash::new(data).to_hex();
        let h2 = Hash::new(data).to_hex();
        assert_eq!(h1, h2);
    }
}

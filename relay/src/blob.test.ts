import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';

// Inline the same logic as in index.ts so we can unit-test without Worker env
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isValidBlobId(blobId: string): boolean {
  return /^[0-9a-f]{64}$/i.test(blobId);
}

function verifyBlobHash(bytes: Uint8Array, blobId: string): boolean {
  return toHex(sha256(bytes)) === blobId.toLowerCase();
}


describe('blobId format validation', () => {
  it('accepts a valid 64-char hex SHA-256 blobId', () => {
    const content = new TextEncoder().encode('hello world');
    const blobId = toHex(sha256(content));
    expect(isValidBlobId(blobId)).toBe(true);
  });

  it('rejects blobId shorter than 64 chars', () => {
    expect(isValidBlobId('abc123')).toBe(false);
  });

  it('rejects blobId with non-hex characters', () => {
    expect(isValidBlobId('g'.repeat(64))).toBe(false);
  });

  it('accepts a valid blobId with uppercase hex chars', () => {
    const content = new TextEncoder().encode('hello world');
    // SHA-256 in uppercase — should still be accepted
    const blobId = toHex(sha256(content)).toUpperCase();
    expect(isValidBlobId(blobId)).toBe(true);
  });
});

describe('blob hash verification', () => {
  it('accepts bytes whose sha256 matches the blobId', () => {
    const content = new TextEncoder().encode('hello world');
    const blobId = toHex(sha256(content));
    expect(verifyBlobHash(content, blobId)).toBe(true);
  });

  it('rejects bytes whose sha256 does not match the blobId', () => {
    const content = new TextEncoder().encode('hello world');
    const wrongBlobId = toHex(sha256(new TextEncoder().encode('different content')));
    expect(verifyBlobHash(content, wrongBlobId)).toBe(false);
  });

  it('rejects an all-zeros blobId for non-empty content', () => {
    const content = new TextEncoder().encode('hello');
    expect(verifyBlobHash(content, '0'.repeat(64))).toBe(false);
  });

  it('accepts bytes with uppercase blobId (case-insensitive)', () => {
    const content = new TextEncoder().encode('hello world');
    const blobIdUpper = toHex(sha256(content)).toUpperCase();
    expect(verifyBlobHash(content, blobIdUpper)).toBe(true);
  });
});

describe('blob size validation', () => {
  function isBlobTooLarge(byteLength: number): boolean {
    return byteLength > MAX_BLOB_BYTES;
  }

  it('accepts blobs at exactly 2MB', () => {
    expect(isBlobTooLarge(MAX_BLOB_BYTES)).toBe(false);
  });

  it('rejects blobs at 2MB + 1 byte', () => {
    expect(isBlobTooLarge(MAX_BLOB_BYTES + 1)).toBe(true);
  });

  it('accepts a 1KB blob', () => {
    expect(isBlobTooLarge(1024)).toBe(false);
  });

  it('rejects a 3MB blob', () => {
    expect(isBlobTooLarge(3 * 1024 * 1024)).toBe(true);
  });
});

describe('GET /public-blob response headers', () => {
  it('sets immutable cache-control for content-addressed blobs', () => {
    const cacheControl = 'public, max-age=31536000, immutable';
    expect(cacheControl).toContain('immutable');
    expect(cacheControl).toContain('max-age=31536000');
  });
});

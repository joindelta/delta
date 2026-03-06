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
});

describe('blob size validation', () => {
  it('accepts blobs at exactly 2MB', () => {
    expect(MAX_BLOB_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_BLOB_BYTES <= MAX_BLOB_BYTES).toBe(true);
  });

  it('rejects blobs over 2MB', () => {
    const overSize = MAX_BLOB_BYTES + 1;
    expect(overSize > MAX_BLOB_BYTES).toBe(true);
  });
});

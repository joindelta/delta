import { describe, it, expect } from 'vitest';
import { seedToX25519Priv, peelLayer } from './onion';
import { hexToBytes, bytesToHex } from './crypto';

describe('seedToX25519Priv', () => {
  it('matches expected RFC 7748 clamp pattern', () => {
    const seed = new Uint8Array(32).fill(0x42);
    const priv = seedToX25519Priv(seed);
    expect(priv.length).toBe(32);
    // Low 3 bits of first byte must be 0
    expect(priv[0] & 0b111).toBe(0);
    // Top bit of last byte must be 0
    expect(priv[31] & 0x80).toBe(0);
    // Bit 6 of last byte must be 1
    expect(priv[31] & 0x40).toBe(0x40);
  });
});

describe('hexToBytes / bytesToHex round-trip', () => {
  it('round-trips', () => {
    const hex = 'deadbeef01020304';
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });
});

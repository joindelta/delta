/**
 * Onion layer peeling — TypeScript port of core/src/onion.rs.
 *
 * Wire format: VERSION[1] | EPK[32] | NONCE[24] | CIPHERTEXT[N]
 * Min valid length: 1 + 32 + 24 + 16 (Poly1305 tag) = 73 bytes
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from './crypto';

const VERSION = 0x02;
const HKDF_INFO = new TextEncoder().encode('delta:onion:v1');
const MIN_LEN = 1 + 32 + 24 + 16;

// ── Key conversion ────────────────────────────────────────────────────────────

/**
 * Convert a 32-byte Ed25519 seed to an X25519 private key.
 * Matches core/src/crypto.rs `ed25519_seed_to_x25519`.
 */
export function seedToX25519Priv(seed: Uint8Array): Uint8Array {
  const hash = sha512(seed);
  const key = hash.slice(0, 32);
  key[0] &= 248;
  key[31] &= 127;
  key[31] |= 64;
  return key;
}

// ── Payload decoding ──────────────────────────────────────────────────────────

export type OnionPayload =
  | { type: 'forward'; nextHopUrl: string; innerPacket: Uint8Array }
  | { type: 'deliver'; topicId: Uint8Array; op: Uint8Array };

function decodePayload(bytes: Uint8Array): OnionPayload {
  if (bytes.length === 0) throw new Error('empty payload');
  const type = bytes[0];

  if (type === 0x01) {
    if (bytes.length < 3) throw new Error('Forward payload too short');
    const urlLen = (bytes[1] << 8) | bytes[2];
    if (bytes.length < 3 + urlLen) throw new Error('Forward URL truncated');
    const url = new TextDecoder().decode(bytes.slice(3, 3 + urlLen));
    const innerPacket = bytes.slice(3 + urlLen);
    return { type: 'forward', nextHopUrl: url, innerPacket };
  }

  if (type === 0x02) {
    if (bytes.length < 1 + 32) throw new Error('Deliver payload too short');
    const topicId = bytes.slice(1, 33);
    const op = bytes.slice(33);
    return { type: 'deliver', topicId, op };
  }

  throw new Error(`unknown payload type 0x${type.toString(16)}`);
}

// ── Layer peeling ─────────────────────────────────────────────────────────────

/**
 * Peel one onion layer.
 *
 * @param envelope        Raw onion packet bytes.
 * @param recipientSeedHex 64 hex chars — Ed25519 seed of this hop's keypair.
 */
export function peelLayer(envelope: Uint8Array, recipientSeedHex: string): OnionPayload {
  if (envelope.length < MIN_LEN) throw new Error('envelope too short');
  if (envelope[0] !== VERSION) throw new Error(`unsupported version 0x${envelope[0].toString(16)}`);

  const epk = envelope.slice(1, 33);
  const nonce = envelope.slice(33, 57);
  const ciphertext = envelope.slice(57);

  const seed = hexToBytes(recipientSeedHex);
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');

  const x25519Priv = seedToX25519Priv(seed);
  const shared = x25519.getSharedSecret(x25519Priv, epk);

  // HKDF-SHA256(ikm=shared, salt=epk, info="delta:onion:v1") → 32-byte key
  const aesKey = hkdf(sha256, shared, epk, HKDF_INFO, 32);

  const plaintext = xchacha20poly1305(aesKey, nonce).decrypt(ciphertext);
  return decodePayload(plaintext);
}

// ── Test helpers (only used in unit tests) ────────────────────────────────────

/** Build an encrypted test packet using @noble crypto — mirrors Rust encrypt_layer. */
export async function buildTestPacket(kind: 'forward' | 'deliver'): Promise<{
  packet: Uint8Array;
  seedHex: string;
  expectedNextUrl?: string;
  expectedInner?: Uint8Array;
  expectedTopicId?: Uint8Array;
  expectedOp?: Uint8Array;
}> {
  const { randomBytes } = await import('@noble/hashes/utils');
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha');

  const seed = randomBytes(32);
  const seedHex = bytesToHex(seed);
  const privKey = seedToX25519Priv(seed);
  const pubKey = x25519.getPublicKey(privKey);

  const ephemeralPriv = randomBytes(32);
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const shared = x25519.getSharedSecret(ephemeralPriv, pubKey);
  const aesKey = hkdf(sha256, shared, ephemeralPub, HKDF_INFO, 32);
  const nonce = randomBytes(24);

  let plaintext: Uint8Array;
  let extras: object;
  if (kind === 'forward') {
    const url = 'https://hop2.example.com/hop';
    const inner = new Uint8Array([1, 2, 3, 4]);
    const urlBytes = new TextEncoder().encode(url);
    plaintext = new Uint8Array(3 + urlBytes.length + inner.length);
    plaintext[0] = 0x01;
    plaintext[1] = (urlBytes.length >> 8) & 0xff;
    plaintext[2] = urlBytes.length & 0xff;
    plaintext.set(urlBytes, 3);
    plaintext.set(inner, 3 + urlBytes.length);
    extras = { expectedNextUrl: url, expectedInner: inner };
  } else {
    const topicId = randomBytes(32);
    const op = new TextEncoder().encode('hello delta');
    plaintext = new Uint8Array(1 + 32 + op.length);
    plaintext[0] = 0x02;
    plaintext.set(topicId, 1);
    plaintext.set(op, 33);
    extras = { expectedTopicId: topicId, expectedOp: op };
  }

  const ciphertext = xchacha20poly1305(aesKey, nonce).encrypt(plaintext);
  const packet = new Uint8Array(1 + 32 + 24 + ciphertext.length);
  packet[0] = VERSION;
  packet.set(ephemeralPub, 1);
  packet.set(nonce, 33);
  packet.set(ciphertext, 57);

  return { packet, seedHex, ...extras } as any;
}

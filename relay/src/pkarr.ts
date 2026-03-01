/**
 * pkarr self-publishing for the Delta relay.
 *
 * Builds and parses relay TXT records in the format:
 *   v=delta1;t=relay;n=<hop_url>;a=<ed25519_pubkey_hex>
 *
 * Publishes to pkarr via HTTP relay (no DHT/sodium-native needed).
 */

import { ed25519 } from '@noble/curves/ed25519';
import dns from 'dns-packet';
import z32 from 'z32';
import { hexToBytes, bytesToHex } from './crypto';

const PKARR_RELAY = 'https://relay.pkarr.org';

/**
 * Build a relay TXT record string.
 *
 * Format: `v=delta1;t=relay;n=<hop_url>;a=<ed25519_pubkey_hex>`
 */
export function buildRelayTxtRecord(pubkeyHex: string, hopUrl: string): string {
  return `v=delta1;t=relay;n=${hopUrl};a=${pubkeyHex}`;
}

/**
 * Parse a relay TXT record string.
 * Returns `{ pubkeyHex, hopUrl }` if this is a relay record, or `null` otherwise.
 */
export function parseRelayTxtRecord(
  txt: string,
): { pubkeyHex: string; hopUrl: string } | null {
  if (!txt.startsWith('v=delta1')) return null;
  const parts = txt.split(';');
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }

  if (fields['t'] !== 'relay') return null;
  if (!fields['n'] || !fields['a']) return null;

  return { pubkeyHex: fields['a'], hopUrl: fields['n'] };
}

/**
 * Encode the BEP44 signable data for a pkarr signed packet.
 *
 * Format (bencode dict minus outer d/e markers):
 *   3:seqi<timestamp>e1:v<len>:<dns bytes>
 *
 * This matches pkarr's encodeSigData without needing the bencode package.
 */
function encodeSigData(timestamp: number, packetBytes: Uint8Array): Uint8Array {
  const seqStr = `3:seqi${timestamp}e`;
  const vStr = `1:v${packetBytes.length}:`;
  const seqBytes = new TextEncoder().encode(seqStr);
  const vPrefixBytes = new TextEncoder().encode(vStr);

  const result = new Uint8Array(seqBytes.length + vPrefixBytes.length + packetBytes.length);
  result.set(seqBytes, 0);
  result.set(vPrefixBytes, seqBytes.length);
  result.set(packetBytes, seqBytes.length + vPrefixBytes.length);
  return result;
}

/**
 * Sign and publish a relay self-record to pkarr via HTTP relay.
 *
 * @param seedHex  - 64 hex char Ed25519 seed for this relay's keypair
 * @param selfUrl  - Base URL of this Worker (e.g. https://relay.delta.app), without trailing slash
 */
export async function publishRelaySelf(
  seedHex: string,
  selfUrl: string,
): Promise<void> {
  const seedBytes = hexToBytes(seedHex);
  const publicKey = ed25519.getPublicKey(seedBytes);
  const pubkeyHex = bytesToHex(publicKey);

  const hopUrl = selfUrl.replace(/\/$/, '') + '/hop';
  const txtValue = buildRelayTxtRecord(pubkeyHex, hopUrl);
  const txtBytes = new TextEncoder().encode(txtValue);

  const packet = {
    type: 'response' as const,
    answers: [
      {
        type: 'TXT' as const,
        name: '_delta-relay',
        ttl: 7200,
        data: [txtBytes],
      },
    ],
  };

  const packetBytes = dns.encode(packet as dns.Packet);
  const timestamp = Math.ceil(Date.now() * 1000); // microseconds

  const signable = encodeSigData(timestamp, packetBytes);
  const signature = ed25519.sign(signable, seedBytes);

  // Construct signed packet bytes: [64-byte sig][8-byte timestamp BE][dns packet]
  const signedBytes = new Uint8Array(64 + 8 + packetBytes.length);
  signedBytes.set(signature, 0);
  const view = new DataView(signedBytes.buffer);
  view.setBigUint64(64, BigInt(timestamp), false); // big-endian
  signedBytes.set(packetBytes, 72);

  const z32Key = z32.encode(publicKey);
  const url = `${PKARR_RELAY}/${z32Key}`;

  const response = await fetch(url, {
    method: 'PUT',
    body: signedBytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  if (!response.ok) {
    throw new Error(`pkarr relay PUT failed: ${response.status}`);
  }
}

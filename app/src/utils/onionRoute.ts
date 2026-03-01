/**
 * Onion route utilities: resolve relay hops from pkarr and send messages.
 */

import { resolvePkarr, buildOnionPacket, type PkarrResolved, type OnionHopFfi } from '../ffi/deltaCore';

/**
 * Parse a PkarrResolved record as a relay hop descriptor.
 * Relay records use: record_type="relay", name=<hop_url>, avatarBlobId=<pubkey_hex>
 */
export function parseRelayRecord(record: PkarrResolved): OnionHopFfi | null {
  if (record.recordType !== 'relay') return null;
  if (!record.name || !record.avatarBlobId) return null;
  return {
    pubkeyHex: record.avatarBlobId,
    nextUrl: record.name,
  };
}

// Convenience alias — parseRelayRecord IS the hop conversion function.
export const hopFromRecord = parseRelayRecord;

/**
 * Resolve a list of relay pkarr z32 keys into ordered hop descriptors.
 * Keys that fail to resolve or are not relay records are silently skipped.
 */
export async function resolveRelayHops(z32Keys: string[]): Promise<OnionHopFfi[]> {
  const hops: OnionHopFfi[] = [];
  for (const key of z32Keys) {
    try {
      const record = await resolvePkarr(key);
      if (!record) continue;
      const hop = parseRelayRecord(record);
      if (hop) hops.push(hop);
    } catch {
      // Individual resolution failures are non-fatal
    }
  }
  return hops;
}

/**
 * Build and send an onion-routed message to a topic.
 *
 * @param hops        Ordered list of relay hop descriptors (first hop is the entry).
 * @param topicId     32-byte topic hash of the final recipient.
 * @param opBytes     Raw p2panda op bytes.
 */
export async function sendOnionMessage(
  hops: OnionHopFfi[],
  topicId: Uint8Array,
  opBytes: Uint8Array,
): Promise<void> {
  if (hops.length === 0) throw new Error('need at least one relay hop');
  if (topicId.length !== 32) throw new Error('topicId must be 32 bytes');

  const packet = await buildOnionPacket(hops, topicId, opBytes);

  const resp = await fetch(hops[0].nextUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: packet,
  });

  if (!resp.ok) throw new Error(`relay returned ${resp.status}`);
}

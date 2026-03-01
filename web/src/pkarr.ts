/**
 * pkarr resolution utilities for the web gateway.
 * Resolves signed DNS packets via HTTP relay (no DHT/native modules needed).
 *
 * Protocol: GET <relay>/<z32-key>
 * Response: 64-byte ed25519 signature + 8-byte timestamp (big-endian u64) + DNS packet bytes
 */

import z32 from 'z32';
import dns from 'dns-packet';

// Public pkarr relay
const PKARR_RELAY = 'https://relay.pkarr.org';

export interface ResolvedRecord {
  recordType: 'user' | 'org' | 'relay' | 'none';
  name?: string;
  username?: string;
  description?: string;
  bio?: string;
  avatarBlobId?: string;
  coverBlobId?: string;
  relayUrl?: string;
  relayPubkey?: string;
  publicKey: string;
}

/**
 * Parse a delta TXT record string.
 * Formats:
 *   v=delta1;t=user;u=<username>;b=<bio>;a=<avatar>
 *   v=delta1;t=org;n=<name>;d=<desc>;a=<avatar>;c=<cover>
 *   v=delta1;t=relay;n=<url>;a=<pubkey>
 */
function parseDeltaRecord(txt: string, z32Key: string): ResolvedRecord {
  const fields: Record<string, string> = {};

  for (const part of txt.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1) {
      fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }

  const recordType = (fields['t'] as ResolvedRecord['recordType']) || 'none';

  return {
    recordType,
    name: fields['n'],
    username: fields['u'],
    description: fields['d'],
    bio: fields['b'],
    avatarBlobId: fields['a'],
    coverBlobId: fields['c'],
    relayUrl: fields['n'], // For relay records, 'n' is the URL
    relayPubkey: fields['a'], // For relay records, 'a' is the pubkey
    publicKey: z32Key,
  };
}

/**
 * Fetch signed packet bytes from a pkarr relay and decode the DNS packet.
 * Bytes layout: [64-byte signature][8-byte timestamp BE][DNS packet]
 */
async function fetchFromRelay(z32Key: string): Promise<dns.Packet | null> {
  const url = `${PKARR_RELAY}/${z32Key}`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Relay error: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length < 72) {
    throw new Error(`Invalid relay response: too short (${bytes.length} bytes)`);
  }

  // Skip 64-byte signature + 8-byte timestamp, decode the DNS packet
  const packetBytes = bytes.subarray(72);
  return dns.decode(Buffer.from(packetBytes));
}

/**
 * Resolve a pkarr record via HTTP relay.
 * @param z32Key - z32-encoded public key (without 'pk:' prefix)
 */
export async function resolvePkarr(z32Key: string): Promise<ResolvedRecord | null> {
  try {
    const packet = await fetchFromRelay(z32Key);
    if (!packet) return null;

    // Look for _delta TXT records
    for (const answer of packet.answers || []) {
      if (answer.type === 'TXT' && answer.name === '_delta') {
        const txtData = (answer as dns.TxtAnswer).data;
        const chunks = Array.isArray(txtData) ? txtData : [txtData];
        if (chunks.length > 0) {
          const txtValue = new TextDecoder().decode(chunks[0] as Uint8Array);
          if (txtValue.startsWith('v=delta1')) {
            return parseDeltaRecord(txtValue, z32Key);
          }
        }
      }
    }

    // Also check for relay records at _delta-relay
    for (const answer of packet.answers || []) {
      if (answer.type === 'TXT' && answer.name === '_delta-relay') {
        const txtData = (answer as dns.TxtAnswer).data;
        const chunks = Array.isArray(txtData) ? txtData : [txtData];
        if (chunks.length > 0) {
          const txtValue = new TextDecoder().decode(chunks[0] as Uint8Array);
          if (txtValue.startsWith('v=delta1')) {
            return parseDeltaRecord(txtValue, z32Key);
          }
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to resolve pkarr:', error);
    return null;
  }
}

/**
 * Resolve a pkarr key from a custom domain's DNS TXT record.
 * Looks for _delta.<domain> TXT record containing pk:<z32-key>
 * @param domain - Custom domain (e.g., "example.com")
 * @returns The z32-encoded public key if found, null otherwise
 */
export async function resolveDomainToPkarr(domain: string): Promise<string | null> {
  try {
    // Use Cloudflare's DNS over HTTPS API
    const dnsName = `_delta.${domain}`;
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(dnsName)}&type=TXT`,
      {
        headers: {
          'Accept': 'application/dns-json',
        },
      }
    );

    if (!response.ok) {
      console.error('DNS query failed:', response.status);
      return null;
    }

    const data = await response.json() as { Answer?: Array<{ type: number; data?: string }> };

    if (!data.Answer || !Array.isArray(data.Answer)) {
      return null;
    }

    // Look for TXT record containing pk:<z32-key>
    for (const answer of data.Answer) {
      if (answer.type === 16) { // TXT record type
        // TXT data is wrapped in quotes in DNS JSON response
        const txtValue = answer.data?.replace(/^"|"$/g, '');
        if (txtValue && txtValue.startsWith('pk:')) {
          const z32Key = txtValue.slice(3); // Remove 'pk:' prefix
          return z32Key;
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to resolve domain:', error);
    return null;
  }
}

// Re-export z32 for use in other modules if needed
export { z32 };

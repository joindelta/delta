/**
 * Delta Relay — Cloudflare Worker.
 *
 * Endpoints:
 *   POST /hop   — receive an onion packet, peel one layer, route it
 *   GET  /pubkey — return this relay's Ed25519 pubkey hex (for discovery)
 *
 * Secrets (set via `wrangler secret put`):
 *   RELAY_SEED_HEX   64 hex char Ed25519 seed
 *   IROH_BRIDGE_URL  URL of the iroh delivery bridge
 */

import { ed25519 } from '@noble/curves/ed25519';
import { peelLayer } from './onion';
import { hexToBytes, bytesToHex } from './crypto';
import { publishRelaySelf } from './pkarr';

export interface Env {
  RELAY_SEED_HEX: string;
  SELF_URL?: string;
  SYNC: Fetcher;   // service binding to delta-sync Worker
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── GET /pubkey — return Ed25519 pubkey for discovery ──────────────────────
    if (request.method === 'GET' && url.pathname === '/pubkey') {
      const seed = hexToBytes(env.RELAY_SEED_HEX);
      const pubkey = ed25519.getPublicKey(seed);
      return new Response(bytesToHex(pubkey), {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // ── POST /hop — peel one onion layer ──────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/hop') {
      const body = await request.arrayBuffer();
      const packet = new Uint8Array(body);

      let payload;
      try {
        payload = peelLayer(packet, env.RELAY_SEED_HEX);
      } catch (err) {
        return new Response('bad packet', { status: 400 });
      }

      if (payload.type === 'forward') {
        const parsedHopUrl = new URL(payload.nextHopUrl);
        if (parsedHopUrl.protocol !== 'https:') {
          return new Response('invalid next hop', { status: 400 });
        }
        const resp = await fetch(payload.nextHopUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload.innerPacket,
        });
        return new Response(null, { status: resp.ok ? 200 : 502 });
      }

      if (payload.type === 'deliver') {
        const topicHex = bytesToHex(payload.topicId);
        const opBase64 = uint8ArrayToBase64(payload.op);

        const resp = await env.SYNC.fetch('https://sync/deliver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic_hex: topicHex, op_base64: opBase64 }),
        });
        return new Response(null, { status: resp.ok ? 200 : 502 });
      }

      return new Response('unknown payload type', { status: 400 });
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const selfUrl = env.SELF_URL ?? 'https://delta-relay.workers.dev';
    await publishRelaySelf(env.RELAY_SEED_HEX, selfUrl);
  },
} satisfies ExportedHandler<Env>;

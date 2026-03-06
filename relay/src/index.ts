/**
 * Gardens Relay — Cloudflare Worker.
 *
 * Endpoints:
 *   POST /hop   — receive an onion packet, peel one layer, route it
 *   GET  /pubkey — return this relay's Ed25519 pubkey hex (for discovery)
 *
 * Secrets (set via `wrangler secret put`):
 *   RELAY_SEED_HEX   64 hex char Ed25519 seed
 *   SELF_URL         Base URL of this Worker without trailing slash (e.g. https://relay.gardens.app)
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { peelLayer } from './onion';
import { hexToBytes, bytesToHex } from './crypto';
import { publishRelaySelf } from './pkarr';

export interface Env {
  RELAY_SEED_HEX: string;
  SELF_URL?: string;
  SYNC: Fetcher;   // service binding to gardens-sync Worker
  PUBLIC_BLOBS: KVNamespace;
}

const MAX_BLOB_BYTES = 2 * 1024 * 1024; // 2 MB

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

    // ── PUT /public-blob/:blobId — store a content-addressed public blob ────────
    if (request.method === 'PUT' && url.pathname.startsWith('/public-blob/')) {
      const blobId = url.pathname.slice('/public-blob/'.length);

      // Validate blobId format (64 hex chars = SHA-256)
      if (!/^[0-9a-f]{64}$/i.test(blobId)) {
        return new Response('invalid blob id', { status: 400 });
      }

      const contentLength = parseInt(request.headers.get('Content-Length') ?? '0', 10);
      if (contentLength > MAX_BLOB_BYTES) {
        return new Response('blob too large (max 2MB)', { status: 413 });
      }

      const bytes = new Uint8Array(await request.arrayBuffer());

      if (bytes.length > MAX_BLOB_BYTES) {
        return new Response('blob too large (max 2MB)', { status: 413 });
      }

      // Content-address verification: sha256(body) must equal blobId
      const computedHash = bytesToHex(sha256(bytes));
      if (computedHash !== blobId.toLowerCase()) {
        return new Response('hash mismatch', { status: 400 });
      }

      const mimeType = request.headers.get('Content-Type') ?? 'application/octet-stream';

      await env.PUBLIC_BLOBS.put(blobId.toLowerCase(), bytes, {
        metadata: { mimeType },
        expirationTtl: 60 * 60 * 24 * 90, // 90 days
      });

      return new Response(null, { status: 204 });
    }

    // ── GET /public-blob/:blobId — serve a stored public blob ──────────────────
    if (request.method === 'GET' && url.pathname.startsWith('/public-blob/')) {
      const blobId = url.pathname.slice('/public-blob/'.length).toLowerCase();

      if (!/^[0-9a-f]{64}$/.test(blobId)) {
        return new Response('invalid blob id', { status: 400 });
      }

      const { value, metadata } = await env.PUBLIC_BLOBS.getWithMetadata<{ mimeType: string }>(
        blobId,
        'arrayBuffer',
      );

      if (!value) {
        return new Response('not found', { status: 404 });
      }

      return new Response(value, {
        headers: {
          'Content-Type': metadata?.mimeType ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const selfUrl = env.SELF_URL ?? 'https://gardens-relay.workers.dev';
    await publishRelaySelf(env.RELAY_SEED_HEX, selfUrl);
  },
} satisfies ExportedHandler<Env>;

/**
 * Delta Sync Worker
 *
 * Endpoints:
 *   GET  /topic/<topic-hex>?since=<seq>  — WebSocket upgrade to TopicDO
 *   POST /deliver                         — from Relay Worker (service binding)
 */

import { TopicDO } from './topic-do';

export { TopicDO };

export interface Env {
  TOPIC_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // GET /topic/<topic-hex>
    if (parts[0] === 'topic' && parts[1]) {
      const topicHex = parts[1];
      if (!/^[0-9a-f]{64}$/i.test(topicHex)) {
        return new Response('invalid topic id', { status: 400 });
      }
      const id = env.TOPIC_DO.idFromName(topicHex);
      const stub = env.TOPIC_DO.get(id);
      return stub.fetch(request);
    }

    // POST /deliver { topic_hex, op_base64 }
    if (request.method === 'POST' && parts[0] === 'deliver') {
      const body = await request.json() as { topic_hex: string; op_base64: string };
      if (!body.topic_hex || !body.op_base64) {
        return new Response('missing fields', { status: 400 });
      }
      if (!/^[0-9a-f]{64}$/i.test(body.topic_hex)) {
        return new Response('invalid topic id', { status: 400 });
      }

      const id = env.TOPIC_DO.idFromName(body.topic_hex);
      const stub = env.TOPIC_DO.get(id);
      const bytes = base64ToBytes(body.op_base64);

      const deliverReq = new Request('https://do/deliver', {
        method: 'POST',
        body: bytes,
      });
      const resp = await stub.fetch(deliverReq);
      return new Response(null, { status: resp.ok ? 200 : 502 });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

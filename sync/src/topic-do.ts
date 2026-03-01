/**
 * TopicDO — Cloudflare Durable Object for per-topic op buffering and fan-out.
 *
 * One instance per topic, named by the 32-byte topic ID hex.
 *
 * Storage layout:
 *   "head"     → number  (highest seq written, starts at 0)
 *   "op:<seq>" → string  (base64-encoded raw p2panda op bytes)
 *
 * Buffer capped at BUFFER_SIZE ops. On overflow, the oldest entry is evicted.
 */

export const BUFFER_SIZE = 1000;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export class TopicDO {
  private storage: DurableObjectStorage;
  private connections: Map<WebSocket, { lastSeq: number }> = new Map();

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');

    // WebSocket upgrade
    if (upgrade?.toLowerCase() === 'websocket') {
      const url = new URL(request.url);
      const since = parseInt(url.searchParams.get('since') ?? '0', 10);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      await this.handleWebSocket(server, since);
      return new Response(null, { status: 101, webSocket: client });
    }

    // POST — deliver op bytes directly
    if (request.method === 'POST') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      await this.receiveOp(bytes);
      return new Response(null, { status: 200 });
    }

    return new Response('not found', { status: 404 });
  }

  async receiveOp(bytes: Uint8Array): Promise<void> {
    const head = ((await this.storage.get<number>('head')) ?? 0) + 1;
    const seq = head;

    const data = uint8ArrayToBase64(bytes);
    await this.storage.put(`op:${seq}`, data);
    await this.storage.put('head', seq);

    // Evict oldest op when buffer exceeds capacity
    if (seq > BUFFER_SIZE) {
      await this.storage.delete(`op:${seq - BUFFER_SIZE}`);
    }

    // Fan out to all live WebSocket clients
    const msg = JSON.stringify({ type: 'op', seq, data });
    for (const [ws] of this.connections) {
      if ((ws as unknown as { readyState: number }).readyState === 1) {
        ws.send(msg);
      }
    }
  }

  async handleWebSocket(ws: WebSocket, since: number): Promise<void> {
    const head = (await this.storage.get<number>('head')) ?? 0;

    // Replay buffered ops from since+1 to head
    for (let seq = since + 1; seq <= head; seq++) {
      const data = await this.storage.get<string>(`op:${seq}`);
      if (data) {
        ws.send(JSON.stringify({ type: 'op', seq, data }));
      }
    }

    // Signal catch-up complete
    ws.send(JSON.stringify({ type: 'ready', head }));

    // Register for live push
    this.connections.set(ws, { lastSeq: head });

    ws.addEventListener('message', async (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as { type: string; data?: string };
        if (msg.type === 'op' && msg.data) {
          await this.receiveOp(base64ToUint8Array(msg.data));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.addEventListener('close', () => {
      this.connections.delete(ws);
    });
  }
}

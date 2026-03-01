import { describe, it, expect } from 'vitest';

// Minimal DO storage stub
function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list<T>(opts: { prefix: string }): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (k.startsWith(opts.prefix)) result.set(k, v as T);
      }
      return result;
    },
  };
}

// Minimal WebSocket stub
function makeWs() {
  const sent: string[] = [];
  const ws = {
    send: (msg: string) => { sent.push(msg); },
    readyState: 1, // OPEN
    accept: () => {},
    addEventListener: (_event: string, _handler: unknown) => {},
    sent,
  };
  return ws;
}

describe('TopicDO', () => {
  it('exports BUFFER_SIZE = 1000', async () => {
    const { BUFFER_SIZE } = await import('./topic-do');
    expect(BUFFER_SIZE).toBe(1000);
  });

  it('stores an op and increments seq', async () => {
    const { TopicDO } = await import('./topic-do');
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    await do_.receiveOp(new Uint8Array([1, 2, 3]));

    const head = await storage.get<number>('head');
    expect(head).toBe(1);
    const op = await storage.get<string>('op:1');
    expect(op).toBeTruthy();
  });

  it('replays buffered ops on connect with since=0', async () => {
    const { TopicDO } = await import('./topic-do');
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    await do_.receiveOp(new Uint8Array([10, 20, 30]));
    await do_.receiveOp(new Uint8Array([40, 50, 60]));

    const ws = makeWs();
    await do_.handleWebSocket(ws as any, 0);

    // 2 replayed ops + 1 ready message
    expect(ws.sent.length).toBe(3);
    const ready = JSON.parse(ws.sent[2]);
    expect(ready).toEqual({ type: 'ready', head: 2 });
  });

  it('only replays ops after since', async () => {
    const { TopicDO } = await import('./topic-do');
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    await do_.receiveOp(new Uint8Array([1]));
    await do_.receiveOp(new Uint8Array([2]));
    await do_.receiveOp(new Uint8Array([3]));

    const ws = makeWs();
    await do_.handleWebSocket(ws as any, 2);

    // only op:3 + ready
    expect(ws.sent.length).toBe(2);
    const ready = JSON.parse(ws.sent[1]);
    expect(ready.head).toBe(3);
  });

  it('evicts oldest op when buffer exceeds BUFFER_SIZE', async () => {
    const { TopicDO, BUFFER_SIZE } = await import('./topic-do');
    const storage = makeStorage();
    const do_ = new TopicDO({ storage } as any, {} as any);

    for (let i = 0; i < BUFFER_SIZE + 1; i++) {
      await do_.receiveOp(new Uint8Array([i % 256]));
    }

    const op1 = await storage.get('op:1');
    expect(op1).toBeUndefined(); // evicted

    const opLast = await storage.get(`op:${BUFFER_SIZE + 1}`);
    expect(opLast).toBeTruthy();
  });
});

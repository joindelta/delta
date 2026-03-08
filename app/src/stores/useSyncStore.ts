/**
 * useSyncStore — manages WebSocket connections to the Gardens Sync Worker (TopicDO).
 *
 * Usage:
 *   const { subscribe, unsubscribe } = useSyncStore();
 *   subscribe(roomId);   // open WS, replay buffered ops, then live push
 *   unsubscribe(roomId); // close WS for that topic
 */

import { create } from 'zustand';
import { ingestOp, getTopicSeq } from '../ffi/gardensCore';
import { ingestEmailOp } from './useInboxStore';
import { blake3 } from '@noble/hashes/blake3';

export const DEFAULT_SYNC_URL = 'https://gardens-sync.stereos.workers.dev';

/** Derive the personal inbox topic for a given public key hex. */
export function deriveInboxTopicHex(pubkeyHex: string): string {
  const bytes = new Uint8Array(
    pubkeyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );
  const suffix = new TextEncoder().encode('gardens:inbox:v1');
  const input = new Uint8Array(bytes.length + suffix.length);
  input.set(bytes);
  input.set(suffix, bytes.length);
  const hash = blake3(input);
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Post a p2panda op to the sync worker for a given topic. Fire-and-forget. */
export function broadcastOp(topicHex: string, opBytes: Uint8Array, syncUrl = DEFAULT_SYNC_URL): void {
  let binary = '';
  for (let i = 0; i < opBytes.length; i++) binary += String.fromCharCode(opBytes[i]);
  const opBase64 = btoa(binary);
  fetch(`${syncUrl}/deliver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic_hex: topicHex, op_base64: opBase64 }),
  }).catch(() => {/* best-effort */});
}

interface TopicSocket {
  ws: WebSocket;
  topicHex: string;
}

interface SyncState {
  sockets: Map<string, TopicSocket>;
  // Incremented each time an op is ingested — screens watch this to re-fetch
  opTick: number;
  subscribe(topicHex: string, syncUrl?: string): void;
  unsubscribe(topicHex: string): void;
  unsubscribeAll(): void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  sockets: new Map(),
  opTick: 0,

  subscribe(topicHex: string, syncUrl = DEFAULT_SYNC_URL) {
    const existing = get().sockets.get(topicHex);
    if (existing) return; // already subscribed

    void (async () => {
      let since = 0;
      try {
        since = await getTopicSeq(topicHex);
      } catch {
        // default to 0 if core not ready
      }

      const wsUrl = syncUrl.replace(/^https?:\/\//, (m) =>
        m === 'https://' ? 'wss://' : 'ws://'
      );
      const ws = new WebSocket(`${wsUrl}/topic/${topicHex}?since=${since}`);
      console.log(`[sync] subscribed topic=${topicHex.slice(0, 16)}… since=${since}`);

      ws.onmessage = async (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            seq?: number;
            data?: string;
          };
          if (msg.type === 'op' && msg.seq != null && msg.data) {
            console.log(`[sync] op received on topic ${topicHex.slice(0, 16)}… seq=${msg.seq} bytes=${msg.data.length}`);
            const binary = atob(msg.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            try {
              await ingestOp(topicHex, msg.seq, bytes);
              console.log(`[sync] ingestOp OK topic=${topicHex.slice(0, 16)}… seq=${msg.seq}`);
            } catch (ingestErr) {
              console.warn(`[sync] ingestOp FAILED topic=${topicHex.slice(0, 16)}… seq=${msg.seq}`, ingestErr);
            }
            try {
              const decoded = atob(msg.data);
              const parsed = JSON.parse(decoded);
              if (parsed?.op_type === 'receive_email') {
                ingestEmailOp(decoded);
              }
            } catch {
              // not an email op
            }
            set((s) => ({ opTick: s.opTick + 1 }));
          }
        } catch (outerErr) {
          console.warn('[sync] onmessage parse error', outerErr);
        }
      };

      ws.onclose = () => {
        set((s) => {
          const next = new Map(s.sockets);
          next.delete(topicHex);
          return { sockets: next };
        });
      };

      ws.onerror = () => {
        ws.close();
      };

      set((s) => {
        const next = new Map(s.sockets);
        next.set(topicHex, { ws, topicHex });
        return { sockets: next };
      });
    })();
  },

  unsubscribe(topicHex: string) {
    const entry = get().sockets.get(topicHex);
    if (entry) {
      entry.ws.close();
      set((s) => {
        const next = new Map(s.sockets);
        next.delete(topicHex);
        return { sockets: next };
      });
    }
  },

  unsubscribeAll() {
    for (const { ws } of get().sockets.values()) {
      ws.close();
    }
    set({ sockets: new Map() });
  },
}));

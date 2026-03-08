import { create } from 'zustand';
import {
  listDmThreads as dcListDmThreads,
  createDmThread as dcCreateDmThread,
  deleteConversation as dcDeleteConversation,
  type DmThread,
} from '../ffi/gardensCore';
import { broadcastOp, deriveInboxTopicHex } from './useSyncStore';
import { DEFAULT_RELAY_URL } from './useProfileStore';

interface ConversationsState {
  conversations: DmThread[];
  requests: DmThread[];

  fetchConversations(): Promise<void>;
  createConversation(recipientKey: string): Promise<string>;
  deleteConversation(threadId: string): Promise<void>;
}

export const useConversationsStore = create<ConversationsState>((set, get) => ({
  conversations: [],
  requests: [],

  async fetchConversations() {
    const all = await dcListDmThreads();
    console.log(`[conversations] fetchConversations → ${all.length} total (${all.filter(t => !t.isRequest).length} conversations, ${all.filter(t => t.isRequest).length} requests)`);
    set({
      conversations: all.filter(t => !t.isRequest),
      requests: all.filter(t => t.isRequest),
    });
  },

  async createConversation(recipientKey: string) {
    const result = await dcCreateDmThread(recipientKey);
    await get().fetchConversations();
    if (result.opBytes?.length) {
      const inboxTopic = deriveInboxTopicHex(recipientKey);
      console.log(`[conversations] broadcasting DM_THREAD op to inbox topic=${inboxTopic.slice(0, 16)}… threadId=${result.id}`);
      broadcastOp(inboxTopic, result.opBytes);
    } else {
      console.warn('[conversations] createConversation returned no opBytes — op will not reach recipient');
    }
    // Push notification so recipient sees the request even when backgrounded
    fetch(`${DEFAULT_RELAY_URL}/push/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientKeys: [recipientKey],
        title: 'New message request',
        body: 'Someone wants to start a conversation with you.',
        data: { type: 'dm_request', threadId: result.id, recipientKey },
      }),
    }).catch(() => {});
    return result.id;
  },

  async deleteConversation(threadId: string) {
    const result = await dcDeleteConversation(threadId);
    if (result.opBytes?.length) {
      broadcastOp(threadId, result.opBytes);
    }
    await get().fetchConversations();
  },
}));

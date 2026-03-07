import { create } from 'zustand';
import { sendMessage as nativeSendMessage, listMessages, deleteMessage as nativeDeleteMessage, listReactions, addReaction, removeReaction, type Reaction } from '../ffi/gardensCore';
import { broadcastOp } from './useSyncStore';

export interface Message {
  messageId: string;
  roomId: string | null;
  dmThreadId: string | null;
  authorKey: string;
  contentType: 'text' | 'audio' | 'image' | 'gif' | 'video' | 'embed';
  textContent: string | null;
  blobId: string | null;
  embedUrl: string | null;
  mentions: string[];
  replyTo: string | null;
  timestamp: number;
  editedAt: number | null;
  isDeleted: boolean;
}

type ContextKey = string; // roomId or dmThreadId

interface MessagesState {
  messages: Record<ContextKey, Message[]>;
  reactions: Record<string, Reaction[]>;

  fetchMessages(
    roomId: string | null,
    dmThreadId: string | null,
    limit?: number,
    beforeTimestamp?: number,
  ): Promise<void>;

  sendMessage(params: {
    roomId?: string;
    dmThreadId?: string;
    contentType: Message['contentType'];
    textContent?: string;
    blobId?: string;
    embedUrl?: string;
    mentions?: string[];
    replyTo?: string;
  }): Promise<string>;

  deleteMessage(messageId: string, orgId?: string): Promise<void>;

  toggleReaction(messageId: string, emoji: string, myPublicKey: string, roomId?: string | null): Promise<void>;
}

const contextKey = (roomId: string | null, dmThreadId: string | null): ContextKey =>
  roomId ?? dmThreadId ?? 'none';

export const useMessagesStore = create<MessagesState>((set) => ({
  messages: {},
  reactions: {},

  async fetchMessages(roomId, dmThreadId, limit = 50, beforeTimestamp) {
    const msgs = await listMessages(
      roomId ?? null,
      dmThreadId ?? null,
      limit,
      beforeTimestamp ?? null,
    );
    const key = contextKey(roomId, dmThreadId);
    // Oldest-first for display.
    set(s => ({ messages: { ...s.messages, [key]: [...msgs].reverse() as Message[] } }));

    const messageIds = msgs.map(m => m.messageId);
    if (messageIds.length > 0) {
      const reactions = await listReactions(messageIds);
      const grouped: Record<string, Reaction[]> = {};
      for (const r of reactions) {
        grouped[r.messageId] = grouped[r.messageId] || [];
        grouped[r.messageId].push(r);
      }
      set(s => ({ reactions: { ...s.reactions, ...grouped } }));
    }
  },

  async sendMessage({ roomId, dmThreadId, contentType, textContent, blobId, embedUrl, mentions = [], replyTo }) {
    const result = await nativeSendMessage(
      roomId ?? null,
      dmThreadId ?? null,
      contentType,
      textContent ?? null,
      blobId ?? null,
      embedUrl ?? null,
      mentions,
      replyTo ?? null,
    );

    // Broadcast op to sync worker so other org members receive it live
    if (roomId && result.opBytes?.length) {
      broadcastOp(roomId, result.opBytes);
    }

    return result.id;
  },

  async deleteMessage(messageId, orgId) {
    await nativeDeleteMessage(messageId, orgId);
    // Optimistically update local state
    set(s => {
      const updatedMessages: Record<string, Message[]> = {};
      for (const key of Object.keys(s.messages)) {
        updatedMessages[key] = s.messages[key].map(msg =>
          msg.messageId === messageId ? { ...msg, isDeleted: true } : msg
        );
      }
      return { messages: updatedMessages };
    });
  },

  async toggleReaction(messageId, emoji, myPublicKey, roomId) {
    const current = useMessagesStore.getState().reactions[messageId] || [];
    const hasReacted = current.some(r => r.emoji === emoji && r.reactorKey === myPublicKey);
    let result: { id: string; opBytesBase64: string };
    if (hasReacted) {
      result = await removeReaction(messageId, emoji);
    } else {
      result = await addReaction(messageId, emoji);
    }
    // Broadcast reaction op to sync worker so other members see it live
    const topic = roomId ?? (() => {
      for (const msgs of Object.values(useMessagesStore.getState().messages)) {
        const found = msgs.find(m => m.messageId === messageId);
        if (found?.roomId) return found.roomId;
      }
      return null;
    })();
    if (topic && result.opBytesBase64) {
      const binary = atob(result.opBytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      broadcastOp(topic, bytes);
    }
    const updated = await listReactions([messageId]);
    set(s => ({ reactions: { ...s.reactions, [messageId]: updated } }));
  },
}));

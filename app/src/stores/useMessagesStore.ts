import { create } from 'zustand';
import { sendMessage as nativeSendMessage, listMessages } from '../ffi/deltaCore';

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
}

const contextKey = (roomId: string | null, dmThreadId: string | null): ContextKey =>
  roomId ?? dmThreadId ?? 'none';

export const useMessagesStore = create<MessagesState>((set) => ({
  messages: {},

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
  },

  async sendMessage({ roomId, dmThreadId, contentType, textContent, blobId, embedUrl, mentions = [], replyTo }) {
    const messageId = await nativeSendMessage(
      roomId ?? null,
      dmThreadId ?? null,
      contentType,
      textContent ?? null,
      blobId ?? null,
      embedUrl ?? null,
      mentions,
      replyTo ?? null,
    );
    return messageId;
  },
}));

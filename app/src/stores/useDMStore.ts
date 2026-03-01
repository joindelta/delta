import { create } from 'zustand';
import {
  listDmThreads as dcListDmThreads,
  createDmThread as dcCreateDmThread,
  subscribeDmTopic,
  type DmThread,
} from '../ffi/deltaCore';

interface DMState {
  threads: DmThread[];

  fetchThreads(): Promise<void>;
  createThread(recipientKey: string): Promise<string>;
}

export const useDMStore = create<DMState>((set, get) => ({
  threads: [],

  async fetchThreads() {
    const threads = await dcListDmThreads();
    set({ threads });
  },

  async createThread(recipientKey: string) {
    const threadId = await dcCreateDmThread(recipientKey);
    await get().fetchThreads();
    try { await subscribeDmTopic(threadId); } catch { /* non-fatal */ }
    return threadId;
  },
}));

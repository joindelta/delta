import { create } from 'zustand';
import { getConnectionStatus, type ConnectionStatus } from '../ffi/deltaCore';

interface NetworkState {
  status: ConnectionStatus;
  startPolling(): void;
  stopPolling(): void;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

export const useNetworkStore = create<NetworkState>((set) => ({
  status: 'Offline',

  startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
      try {
        const status = await getConnectionStatus();
        set({ status });
      } catch {
        set({ status: 'Offline' });
      }
    }, 3000);
  },

  stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  },
}));

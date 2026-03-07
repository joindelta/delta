import { create } from 'zustand';
import * as Keychain from 'react-native-keychain';

const DND_SERVICE = 'gardens.dndEnabled';

interface SettingsState {
  dndEnabled: boolean;
  hydrated: boolean;
  loadSettings(): Promise<void>;
  setDnd(enabled: boolean): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  dndEnabled: false,
  hydrated: false,

  async loadSettings() {
    try {
      const result = await Keychain.getGenericPassword({ service: DND_SERVICE });
      set({ dndEnabled: result !== false && result.password === 'true', hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  async setDnd(enabled: boolean) {
    try {
      await Keychain.setGenericPassword('key', enabled ? 'true' : 'false', {
        service: DND_SERVICE,
      });
      set({ dndEnabled: enabled });
    } catch {
      // ignore storage errors
    }
  },
}));

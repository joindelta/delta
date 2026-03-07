import { create } from 'zustand';
import * as Keychain from 'react-native-keychain';

const dismissedService = (orgId: string) => `gardens.welcomeDismissed.${orgId}`;

async function readService(service: string): Promise<string | null> {
  try {
    const result = await Keychain.getGenericPassword({ service });
    return result?.password ?? null;
  } catch {
    return null;
  }
}

async function writeService(service: string, value: string | null): Promise<void> {
  if (value === null) {
    await Keychain.resetGenericPassword({ service });
    return;
  }
  await Keychain.setGenericPassword('key', value, { service });
}

interface OrgWelcomeState {
  dismissed: Record<string, boolean>;
  load(orgId: string): Promise<void>;
  setDismissed(orgId: string, value: boolean): Promise<void>;
}

export const useOrgWelcomeStore = create<OrgWelcomeState>((set) => ({
  dismissed: {},

  async load(orgId) {
    const raw = await readService(dismissedService(orgId));
    set(s => ({ dismissed: { ...s.dismissed, [orgId]: raw === 'true' } }));
  },

  async setDismissed(orgId, value) {
    await writeService(dismissedService(orgId), String(value));
    set(s => ({ dismissed: { ...s.dismissed, [orgId]: value } }));
  },
}));

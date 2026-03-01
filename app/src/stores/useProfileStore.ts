import { create } from 'zustand';
import * as Keychain from 'react-native-keychain';
import {
  getMyProfile,
  getProfile,
  createOrUpdateProfile as dcCreateOrUpdateProfile,
  type Profile,
} from '../ffi/deltaCore';

export type { Profile };

const PROFILE_PIC_SERVICE  = 'delta.profilePicUri';
const LOCAL_USERNAME_SERVICE = 'delta.localUsername';

interface ProfileState {
  myProfile: Profile | null;
  profileCache: Record<string, Profile>;
  profilePicUri: string | null;
  /** Locally persisted username — set at signup, used as fallback if myProfile is null. */
  localUsername: string | null;

  fetchMyProfile(): Promise<void>;
  fetchProfile(publicKey: string): Promise<Profile | null>;
  createOrUpdateProfile(username: string, bio: string | null, availableFor: string[]): Promise<void>;
  setProfilePicUri(uri: string | null): Promise<void>;
  loadProfilePicUri(): Promise<void>;
  setLocalUsername(name: string): Promise<void>;
  loadLocalUsername(): Promise<void>;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  myProfile: null,
  profileCache: {},
  profilePicUri: null,
  localUsername: null,

  async fetchMyProfile() {
    const profile = await getMyProfile();
    if (profile) set({ myProfile: profile });
  },

  async fetchProfile(publicKey: string) {
    const cached = get().profileCache[publicKey];
    if (cached) return cached;
    const profile = await getProfile(publicKey);
    if (profile) {
      set(s => ({ profileCache: { ...s.profileCache, [publicKey]: profile } }));
    }
    return profile ?? null;
  },

  async createOrUpdateProfile(username, bio, availableFor) {
    await dcCreateOrUpdateProfile(username, bio, availableFor);
    await get().fetchMyProfile();
  },

  async setProfilePicUri(uri: string | null) {
    if (uri) {
      await Keychain.setGenericPassword('key', uri, { service: PROFILE_PIC_SERVICE });
    } else {
      await Keychain.resetGenericPassword({ service: PROFILE_PIC_SERVICE });
    }
    set({ profilePicUri: uri });
  },

  async loadProfilePicUri() {
    try {
      const result = await Keychain.getGenericPassword({ service: PROFILE_PIC_SERVICE });
      if (result) set({ profilePicUri: result.password });
    } catch {}
  },

  async setLocalUsername(name: string) {
    await Keychain.setGenericPassword('key', name, { service: LOCAL_USERNAME_SERVICE });
    set({ localUsername: name });
  },

  async loadLocalUsername() {
    try {
      const result = await Keychain.getGenericPassword({ service: LOCAL_USERNAME_SERVICE });
      if (result) set({ localUsername: result.password });
    } catch {}
  },
}));

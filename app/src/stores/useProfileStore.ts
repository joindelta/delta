import { create } from 'zustand';
import * as Keychain from 'react-native-keychain';
import {
  getMyProfile,
  getProfile,
  getBlob,
  getPkarrUrl,
  createOrUpdateProfile as dcCreateOrUpdateProfile,
  type Profile,
} from '../ffi/gardensCore';

export type { Profile };

export const DEFAULT_RELAY_URL = 'https://gardens-relay.stereos.workers.dev';

export async function uploadBlobToRelay(
  blobBytes: Uint8Array,
  blobId: string,
  mimeType: string,
  relayBaseUrl: string,
): Promise<void> {
  const resp = await fetch(`${relayBaseUrl}/public-blob/${blobId}`, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: blobBytes,
  });
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`Failed to upload blob to relay: ${resp.status}`);
  }
}

export async function getRelayZ32(relayBaseUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(`${relayBaseUrl}/pubkey`);
    if (!resp.ok) return null;
    const pubkeyHex = (await resp.text()).trim();
    const pkarrUrl = getPkarrUrl(pubkeyHex); // returns "pk:<z32>"
    return pkarrUrl.replace('pk:', '');
  } catch {
    return null;
  }
}

const PROFILE_PIC_SERVICE  = 'gardens.profilePicUri';
const LOCAL_USERNAME_SERVICE = 'gardens.localUsername';

interface ProfileState {
  myProfile: Profile | null;
  profileCache: Record<string, Profile>;
  profilePicUri: string | null;
  /** Locally persisted username — set at signup, used as fallback if myProfile is null. */
  localUsername: string | null;

  fetchMyProfile(): Promise<void>;
  fetchProfile(publicKey: string): Promise<Profile | null>;
  createOrUpdateProfile(username: string, bio: string | null, availableFor: string[], isPublic?: boolean, avatarBlobId?: string | null): Promise<void>;
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

  async createOrUpdateProfile(username, bio, availableFor, isPublic = false, avatarBlobId = null) {
    if (isPublic) {
      const blobToUpload = avatarBlobId ?? get().myProfile?.avatarBlobId ?? null;
      if (blobToUpload) {
        try {
          const bytes = await getBlob(blobToUpload, null);
          await uploadBlobToRelay(bytes, blobToUpload, 'application/octet-stream', DEFAULT_RELAY_URL);
        } catch (e) {
          console.warn('[relay] Failed to upload avatar to relay:', e);
        }
      }
    }
    await dcCreateOrUpdateProfile(username, bio, availableFor, isPublic, avatarBlobId, false);
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

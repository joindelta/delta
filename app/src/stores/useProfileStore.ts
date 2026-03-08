import { create } from 'zustand';
import * as Keychain from 'react-native-keychain';
import {
  getMyProfile,
  getProfile,
  getBlob,
  getPkarrUrl,
  resolvePkarr,
  createOrUpdateProfile as dcCreateOrUpdateProfile,
  type Profile,
} from '../ffi/gardensCore';
import { getDmProfile } from './useDmProfileStore';

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
  createOrUpdateProfile(username: string, bio: string | null, availableFor: string[], isPublic?: boolean, avatarBlobId?: string | null, emailEnabled?: boolean): Promise<void>;
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
    // 1. In-memory cache
    const cached = get().profileCache[publicKey];
    if (cached) return cached;

    // 2. AsyncStorage KV (profiles exchanged via DM channel)
    const dm = await getDmProfile(publicKey);
    if (dm) {
      const profile: Profile = {
        publicKey: dm.publicKey,
        username: dm.username,
        avatarBlobId: dm.avatarBlobId,
        bio: null,
        availableFor: [],
        isPublic: false,
        createdAt: dm.cachedAt,
        updatedAt: dm.cachedAt,
      };
      set(s => ({ profileCache: { ...s.profileCache, [publicKey]: profile } }));
      return profile;
    }

    // 3. Native local store (org members, previously synced profiles)
    const profile = await getProfile(publicKey);
    if (profile) {
      set(s => ({ profileCache: { ...s.profileCache, [publicKey]: profile } }));
      return profile;
    }

    // 4. pkarr network resolution (public profiles only)
    try {
      const pkarrUrl = getPkarrUrl(publicKey); // returns "pk:<z32>"
      const z32 = pkarrUrl.replace('pk:', '');
      const resolved = await resolvePkarr(z32);
      if (resolved?.username) {
        const p: Profile = {
          publicKey,
          username: resolved.username,
          avatarBlobId: resolved.avatarBlobId ?? null,
          bio: resolved.bio ?? null,
          availableFor: [],
          isPublic: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set(s => ({ profileCache: { ...s.profileCache, [publicKey]: p } }));
        return p;
      }
    } catch {
      // pkarr unavailable or no public profile — not an error
    }

    return null;
  },

  async createOrUpdateProfile(username, bio, availableFor, isPublic = false, avatarBlobId = null, emailEnabled = false) {
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
    await dcCreateOrUpdateProfile(username, bio, availableFor, isPublic, avatarBlobId, emailEnabled);
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

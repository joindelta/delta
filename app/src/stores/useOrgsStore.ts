import { create } from 'zustand';
import {
  createOrg as dcCreateOrg,
  listMyOrgs as dcListMyOrgs,
  updateOrg as dcUpdateOrg,
  deleteOrg as dcDeleteOrg,
  leaveOrg as dcLeaveOrg,
  listRooms as dcListRooms,
  createRoom as dcCreateRoom,
  updateRoom as dcUpdateRoom,
  deleteRoom as dcDeleteRoom,
  archiveRoom as dcArchiveRoom,
  unarchiveRoom as dcUnarchiveRoom,
  getBlob,
  type OrgSummary,
  type Room,
} from '../ffi/gardensCore';
import { uploadBlobToRelay, DEFAULT_RELAY_URL } from './useProfileStore';
import { broadcastOp } from './useSyncStore';

interface OrgsState {
  orgs: OrgSummary[];
  rooms: Record<string, Room[]>; // orgId → rooms
  deletedOrgIds: string[];

  fetchMyOrgs(): Promise<void>;
  createOrg(
    name: string,
    typeLabel: string,
    description: string | null,
    isPublic: boolean,
  ): Promise<string>;
  updateOrg(
    orgId: string,
    name?: string | null,
    typeLabel?: string | null,
    description?: string | null,
    avatarBlobId?: string | null,
    coverBlobId?: string | null,
    welcomeText?: string | null,
    customEmojiJson?: string | null,
    orgCooldownSecs?: number | null,
    isPublic?: boolean | null,
    emailEnabled?: boolean | null,
  ): Promise<void>;
  deleteOrg(orgId: string): Promise<void>;
  fetchRooms(orgId: string, includeArchived?: boolean): Promise<void>;
  createRoom(orgId: string, name: string): Promise<string>;
  updateRoom(orgId: string, roomId: string, name?: string, roomCooldownSecs?: number): Promise<void>;
  deleteRoom(orgId: string, roomId: string): Promise<void>;
  archiveRoom(orgId: string, roomId: string): Promise<void>;
  unarchiveRoom(orgId: string, roomId: string): Promise<void>;
  leaveOrg(orgId: string): Promise<void>;
}

export const useOrgsStore = create<OrgsState>((set, get) => ({
  orgs: [],
  rooms: {},
  deletedOrgIds: [],

  async fetchMyOrgs() {
    const orgs = await dcListMyOrgs();
    const hidden = new Set(get().deletedOrgIds);
    set({ orgs: orgs.filter(o => !hidden.has(o.orgId)) });
  },

  async createOrg(name, typeLabel, description, isPublic) {
    const orgId = await dcCreateOrg(name, typeLabel, description, isPublic);
    await get().fetchMyOrgs();
    return orgId;
  },

  async updateOrg(orgId, name, typeLabel, description, avatarBlobId, coverBlobId, welcomeText, customEmojiJson, orgCooldownSecs, isPublic, emailEnabled) {
    if (isPublic && avatarBlobId) {
      try {
        const bytes = await getBlob(avatarBlobId, null);
        await uploadBlobToRelay(bytes, avatarBlobId, 'application/octet-stream', DEFAULT_RELAY_URL);
      } catch (e) {
        console.warn('[relay] Failed to upload org avatar to relay:', e);
      }
    }
    if (isPublic && coverBlobId) {
      try {
        const bytes = await getBlob(coverBlobId, null);
        await uploadBlobToRelay(bytes, coverBlobId, 'application/octet-stream', DEFAULT_RELAY_URL);
      } catch (e) {
        console.warn('[relay] Failed to upload org cover to relay:', e);
      }
    }
    const result = await dcUpdateOrg(
      orgId,
      name ?? null,
      typeLabel ?? null,
      description ?? null,
      avatarBlobId ?? null,
      coverBlobId ?? null,
      welcomeText ?? null,
      customEmojiJson ?? null,
      orgCooldownSecs ?? null,
      isPublic ?? null,
      emailEnabled ?? null,
    );
    broadcastOp(orgId, result.opBytes);
    await get().fetchMyOrgs();
    await get().fetchRooms(orgId);
  },

  async deleteOrg(orgId: string) {
    await dcDeleteOrg(orgId);
    set(s => {
      const { [orgId]: _removed, ...restRooms } = s.rooms;
      return {
        orgs: s.orgs.filter(o => o.orgId !== orgId),
        rooms: restRooms,
        deletedOrgIds: s.deletedOrgIds.includes(orgId) ? s.deletedOrgIds : [...s.deletedOrgIds, orgId],
      };
    });
  },

  async leaveOrg(orgId: string) {
    const result = await dcLeaveOrg(orgId);
    if (result.opBytes?.length) {
      broadcastOp(orgId, result.opBytes);
    }
    set(s => {
      const { [orgId]: _removed, ...restRooms } = s.rooms;
      return {
        orgs: s.orgs.filter(o => o.orgId !== orgId),
        rooms: restRooms,
        deletedOrgIds: s.deletedOrgIds.includes(orgId) ? s.deletedOrgIds : [...s.deletedOrgIds, orgId],
      };
    });
  },

  async fetchRooms(orgId, includeArchived = false) {
    const rooms = await dcListRooms(orgId, includeArchived);
    set(s => ({ rooms: { ...s.rooms, [orgId]: rooms } }));
  },

  async createRoom(orgId, name) {
    const roomId = await dcCreateRoom(orgId, name);
    await get().fetchRooms(orgId);
    return roomId;
  },

  async updateRoom(orgId, roomId, name, roomCooldownSecs) {
    await dcUpdateRoom(orgId, roomId, name ?? null, roomCooldownSecs ?? null);
    await get().fetchRooms(orgId);
  },

  async deleteRoom(orgId, roomId) {
    await dcDeleteRoom(orgId, roomId);
    await get().fetchRooms(orgId);
  },

  async archiveRoom(orgId, roomId) {
    await dcArchiveRoom(orgId, roomId);
    await get().fetchRooms(orgId);
  },

  async unarchiveRoom(orgId, roomId) {
    await dcUnarchiveRoom(orgId, roomId);
    await get().fetchRooms(orgId);
  },
}));

import { create } from 'zustand';
import {
  createOrg as dcCreateOrg,
  listMyOrgs as dcListMyOrgs,
  updateOrg as dcUpdateOrg,
  listRooms as dcListRooms,
  createRoom as dcCreateRoom,
  updateRoom as dcUpdateRoom,
  deleteRoom as dcDeleteRoom,
  archiveRoom as dcArchiveRoom,
  unarchiveRoom as dcUnarchiveRoom,
  type OrgSummary,
  type Room,
} from '../ffi/deltaCore';

interface OrgsState {
  orgs: OrgSummary[];
  rooms: Record<string, Room[]>; // orgId → rooms

  fetchMyOrgs(): Promise<void>;
  createOrg(
    name: string,
    typeLabel: string,
    description: string | null,
    isPublic: boolean,
  ): Promise<string>;
  updateOrg(
    orgId: string,
    name?: string,
    typeLabel?: string,
    description?: string,
    avatarBlobId?: string,
    coverBlobId?: string,
    isPublic?: boolean,
  ): Promise<void>;
  fetchRooms(orgId: string, includeArchived?: boolean): Promise<void>;
  createRoom(orgId: string, name: string): Promise<string>;
  updateRoom(orgId: string, roomId: string, name?: string): Promise<void>;
  deleteRoom(orgId: string, roomId: string): Promise<void>;
  archiveRoom(orgId: string, roomId: string): Promise<void>;
  unarchiveRoom(orgId: string, roomId: string): Promise<void>;
}

export const useOrgsStore = create<OrgsState>((set, get) => ({
  orgs: [],
  rooms: {},

  async fetchMyOrgs() {
    const orgs = await dcListMyOrgs();
    set({ orgs });
  },

  async createOrg(name, typeLabel, description, isPublic) {
    const orgId = await dcCreateOrg(name, typeLabel, description, isPublic);
    await get().fetchMyOrgs();
    return orgId;
  },

  async updateOrg(orgId, name, typeLabel, description, avatarBlobId, coverBlobId, isPublic) {
    await dcUpdateOrg(
      orgId,
      name ?? null,
      typeLabel ?? null,
      description ?? null,
      avatarBlobId ?? null,
      coverBlobId ?? null,
      isPublic ?? null,
    );
    await get().fetchMyOrgs();
    await get().fetchRooms(orgId);
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

  async updateRoom(orgId, roomId, name) {
    await dcUpdateRoom(orgId, roomId, name ?? null);
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

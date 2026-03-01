import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Menu, Search } from 'lucide-react-native';
import { useOrgsStore } from '../stores/useOrgsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useProfileStore } from '../stores/useProfileStore';
import { useAuthStore } from '../stores/useAuthStore';
import { ChannelMessage } from '../components/ChannelMessage';
import { MessageComposer } from '../components/MessageComposer';
import { OrgSearchPanel } from '../components/OrgSearchPanel';
import { listOrgMembers } from '../ffi/deltaCore';
import { BlobImage } from '../components/BlobImage';

const DRAWER_WIDTH = 280;
const EDGE_HIT_WIDTH = 20;
const SNAP_THRESHOLD = DRAWER_WIDTH * 0.3;
const VEL_THRESHOLD = 0.5;

// ─── Banner gradient ──────────────────────────────────────────────────────────

const GRADIENT_PAIRS: [string, string][] = [
  ['#1a1a2e', '#16213e'],
  ['#0f3460', '#533483'],
  ['#1b1b2f', '#2c2c54'],
  ['#162447', '#1f4068'],
  ['#1a0533', '#3b0a45'],
  ['#0d1b2a', '#1b4332'],
  ['#2d1b33', '#1a1a2e'],
];

function orgGradient(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GRADIENT_PAIRS[Math.abs(hash) % GRADIENT_PAIRS.length];
}

function OrgBanner({ orgId, orgName, coverBlobId }: { orgId: string; orgName: string; coverBlobId?: string | null }) {
  const [bg1, bg2] = orgGradient(orgId);
  const initials = orgName.slice(0, 2).toUpperCase();

  if (coverBlobId) {
    return (
      <View style={bannerStyles.root}>
        <BlobImage blobHash={coverBlobId} style={bannerStyles.coverImage} />
        <View style={bannerStyles.content}>
          <View style={[bannerStyles.avatar, { borderColor: '#111' }]}>
            <Text style={bannerStyles.avatarText}>{initials}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[bannerStyles.root, { backgroundColor: bg1 }]}>
      <View style={[bannerStyles.overlay, { backgroundColor: bg2 }]} />
      <View style={bannerStyles.content}>
        <View style={[bannerStyles.avatar, { borderColor: '#111' }]}>
          <Text style={bannerStyles.avatarText}>{initials}</Text>
        </View>
      </View>
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  root: { height: 120, overflow: 'hidden' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.45 },
  coverImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  content: { flex: 1, justifyContent: 'flex-end', padding: 14 },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});

// ─── Main screen ─────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<any, 'OrgChat'>;

export function OrgChatScreen({ route, navigation }: Props) {
  const { orgId, orgName } = route.params as { orgId: string; orgName: string };

  const { rooms, fetchRooms, createRoom, orgs } = useOrgsStore();
  const org = orgs.find(o => o.orgId === orgId);
  const { messages, fetchMessages, sendMessage } = useMessagesStore();
  const { myProfile, profileCache, fetchProfile } = useProfileStore();

  const [activeRoomId, setActiveRoomId]     = useState<string | null>(null);
  const [activeRoomName, setActiveRoomName] = useState('');
  const [memberCount, setMemberCount]       = useState(0);
  const [isAdmin, setIsAdmin]               = useState(false);
  const [loadingRooms, setLoadingRooms]     = useState(true);
  const [loadingMsgs, setLoadingMsgs]       = useState(false);
  const [replyingTo, setReplyingTo]         = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen]     = useState(false);
  const [isSearchOpen, setIsSearchOpen]     = useState(false);
  const [creatingRoom, setCreatingRoom]     = useState(false);
  const [newRoomName, setNewRoomName]       = useState('');
  const [roomBusy, setRoomBusy]             = useState(false);

  const flatListRef   = useRef<FlatList>(null);
  const drawerX       = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const drawerIsOpen  = useRef(false); // ref for PanResponder closures
  const isNearBottom  = useRef(true);

  const orgRooms   = rooms[orgId] || [];
  const messageList = activeRoomId ? (messages[activeRoomId] || []) : [];

  // ── Drawer helpers ──────────────────────────────────────────────────────────

  function openDrawer() {
    drawerIsOpen.current = true;
    setIsDrawerOpen(true);
    Animated.spring(drawerX, {
      toValue: 0,
      useNativeDriver: true,
      tension: 100,
      friction: 12,
    }).start();
  }

  function closeDrawer() {
    drawerIsOpen.current = false;
    Animated.spring(drawerX, {
      toValue: -DRAWER_WIDTH,
      useNativeDriver: true,
      tension: 100,
      friction: 12,
    }).start(() => setIsDrawerOpen(false));
  }

  // ── Edge zone PanResponder (opens drawer from closed state) ─────────────────

  const edgePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) =>
        !drawerIsOpen.current && gs.dx > 8 && Math.abs(gs.dy) < gs.dx,
      onPanResponderMove: (_, gs) => {
        const val = Math.min(0, -DRAWER_WIDTH + gs.dx);
        drawerX.setValue(val);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx > SNAP_THRESHOLD || gs.vx > VEL_THRESHOLD) {
          openDrawer();
        } else {
          closeDrawer();
        }
      },
    })
  ).current;

  // ── Drawer panel PanResponder (closes drawer via swipe-left) ────────────────

  const drawerPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) =>
        drawerIsOpen.current && gs.dx < -8 && Math.abs(gs.dy) < Math.abs(gs.dx),
      onPanResponderMove: (_, gs) => {
        const val = Math.max(-DRAWER_WIDTH, Math.min(0, gs.dx));
        drawerX.setValue(val);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx < -SNAP_THRESHOLD || gs.vx < -VEL_THRESHOLD) {
          closeDrawer();
        } else {
          openDrawer();
        }
      },
    })
  ).current;

  // ── Header ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    navigation.setOptions({
      title: activeRoomName ? `#${activeRoomName}` : orgName,
      headerLeft: () => (
        <TouchableOpacity style={[s.headerBtn, { marginRight: 8 }]} onPress={openDrawer}>
          <Menu size={20} color="#fff" />
        </TouchableOpacity>
      ),
      headerRight: () => (
        <TouchableOpacity style={s.headerBtn} onPress={() => setIsSearchOpen(true)}>
          <Search size={18} color="#fff" />
        </TouchableOpacity>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomName, navigation, orgId, orgName]);

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    loadInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Fetch profiles for any authors not yet in cache
  useEffect(() => {
    const keys = [...new Set(messageList.map(m => m.authorKey))];
    keys.forEach(key => {
      if (!profileCache[key]) fetchProfile(key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageList]);

  async function loadInitial() {
    setLoadingRooms(true);
    try {
      await fetchRooms(orgId);
      let fresh = useOrgsStore.getState().rooms[orgId] || [];
      // Bootstrap a general channel if the native module didn't auto-create one
      if (fresh.length === 0) {
        await createRoom(orgId, 'general');
        fresh = useOrgsStore.getState().rooms[orgId] || [];
      }
      if (fresh.length > 0) {
        const defaultRoom = fresh.find(r => r.name === 'general') ?? fresh[0];
        await switchRoom(defaultRoom.roomId, defaultRoom.name);
      }
      try {
        const members = await listOrgMembers(orgId);
        setMemberCount(members.length);
        const myKey = useProfileStore.getState().myProfile?.publicKey
          ?? useAuthStore.getState().keypair?.publicKeyHex;
        const me = members.find(m => m.publicKey === myKey);
        setIsAdmin(me?.accessLevel === 'manage');
      } catch {
        // member count is non-critical
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load channels');
    } finally {
      setLoadingRooms(false);
    }
  }

  // ── Channel switch ──────────────────────────────────────────────────────────

  async function switchRoom(roomId: string, roomName: string) {
    setActiveRoomId(roomId);
    setActiveRoomName(roomName);
    closeDrawer();
    setLoadingMsgs(true);
    try {
      await fetchMessages(roomId, null);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 50);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load messages');
    } finally {
      setLoadingMsgs(false);
    }
  }

  // ── Send message ────────────────────────────────────────────────────────────

  async function handleSend(text: string) {
    if (!activeRoomId) return;
    try {
      await sendMessage({ roomId: activeRoomId, contentType: 'text', textContent: text, replyTo: replyingTo ?? undefined });
      setReplyingTo(null);
      await fetchMessages(activeRoomId, null);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send');
    }
  }

  async function handleSendBlob(blobId: string, _mimeType: string, contentType: 'image' | 'video') {
    if (!activeRoomId) return;
    try {
      await sendMessage({ roomId: activeRoomId, contentType, blobId, replyTo: replyingTo ?? undefined });
      setReplyingTo(null);
      await fetchMessages(activeRoomId, null);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send');
    }
  }

  async function handleSendAudio(blobId: string) {
    if (!activeRoomId) return;
    try {
      await sendMessage({ roomId: activeRoomId, contentType: 'audio', blobId, replyTo: replyingTo ?? undefined });
      setReplyingTo(null);
      await fetchMessages(activeRoomId, null);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send');
    }
  }

  async function handleSendGif(embedUrl: string) {
    if (!activeRoomId) return;
    try {
      await sendMessage({ roomId: activeRoomId, contentType: 'gif', embedUrl, replyTo: replyingTo ?? undefined });
      setReplyingTo(null);
      await fetchMessages(activeRoomId, null);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send');
    }
  }

  // ── Create room ─────────────────────────────────────────────────────────────

  async function handleSubmitRoom() {
    if (!newRoomName.trim()) return;
    setRoomBusy(true);
    try {
      const name = newRoomName.trim();
      const roomId = await createRoom(orgId, name);
      setCreatingRoom(false);
      setNewRoomName('');
      await switchRoom(roomId, name);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create channel');
    } finally {
      setRoomBusy(false);
    }
  }

  // ── Overlay opacity ─────────────────────────────────────────────────────────

  const overlayOpacity = drawerX.interpolate({
    inputRange: [-DRAWER_WIDTH, 0],
    outputRange: [0, 0.55],
    extrapolate: 'clamp',
  });

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loadingRooms) {
    return (
      <View style={s.center}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={s.root}>

      {/* Chat area */}
      {loadingMsgs ? (
        <View style={s.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : activeRoomId ? (
        <>
          <FlatList
            ref={flatListRef}
            style={s.messages}
            data={messageList}
            keyExtractor={item => item.messageId}
            contentContainerStyle={s.messagesList}
            renderItem={({ item, index }) => {
              const prev = index > 0 ? messageList[index - 1] : null;
              const isGrouped = prev?.authorKey === item.authorKey;
              const profile = profileCache[item.authorKey];
              const authorUsername = profile?.username ?? item.authorKey.slice(0, 8);
              const authorAvatarBlobId = profile?.avatarBlobId ?? null;
              return (
                <ChannelMessage
                  message={item}
                  isOwnMessage={item.authorKey === myProfile?.publicKey}
                  isGrouped={isGrouped}
                  authorUsername={authorUsername}
                  authorAvatarBlobId={authorAvatarBlobId}
                  onReply={() => setReplyingTo(item.messageId)}
                  onLongPress={() =>
                    Alert.alert('Message Actions', 'Choose an action', [
                      { text: 'Reply', onPress: () => setReplyingTo(item.messageId) },
                      { text: 'Cancel', style: 'cancel' },
                    ])
                  }
                />
              );
            }}
            onScroll={({ nativeEvent }) => {
              const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
              isNearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
            }}
            scrollEventThrottle={16}
            onContentSizeChange={() => {
              if (isNearBottom.current) {
                flatListRef.current?.scrollToEnd({ animated: false });
              }
            }}
            ListEmptyComponent={
              <View style={s.emptyMessages}>
                <Text style={s.emptyText}>No messages yet. Say hello!</Text>
              </View>
            }
          />
          <MessageComposer
            roomId={activeRoomId}
            onSend={handleSend}
            onSendBlob={handleSendBlob}
            onSendAudio={handleSendAudio}
            onSendGif={handleSendGif}
            placeholder={`Message #${activeRoomName}`}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
          />
        </>
      ) : (
        <View style={s.center}>
          <Text style={s.emptyText}>No channels yet</Text>
        </View>
      )}

      {/* Left edge swipe zone — opens drawer */}
      <View style={s.edgeZone} {...edgePan.panHandlers} />

      {/* Full-screen drawer Modal — covers header and status bar */}
      <Modal
        visible={isDrawerOpen}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={closeDrawer}
      >
        {/* Dimming overlay — tap to close */}
        <Animated.View style={[s.overlay, { opacity: overlayOpacity }]} pointerEvents="auto">
          <Pressable style={StyleSheet.absoluteFill} onPress={closeDrawer} />
        </Animated.View>

        {/* Drawer panel */}
        <Animated.View
          style={[s.drawer, { transform: [{ translateX: drawerX }] }]}
          {...drawerPan.panHandlers}
        >
          <OrgBanner orgId={orgId} orgName={orgName} coverBlobId={org?.coverBlobId} />

          <View style={s.orgInfo}>
            <View style={s.orgInfoRow}>
              <Text style={s.orgName}>{orgName}</Text>
              {isAdmin && (
                <TouchableOpacity
                  style={s.settingsBtn}
                  onPress={() => { closeDrawer(); navigation.navigate('OrgSettings', { orgId, orgName }); }}
                >
                  <Text style={s.settingsBtnText}>⚙</Text>
                </TouchableOpacity>
              )}
            </View>
            {memberCount > 0 && (
              <Text style={s.memberCount}>
                {memberCount} member{memberCount !== 1 ? 's' : ''}
              </Text>
            )}
          </View>

          {creatingRoom ? (
            /* ── Inline create-channel form ── */
            <View style={s.createForm}>
              <Text style={s.sectionLabel}>NEW CHANNEL</Text>
              <TextInput
                value={newRoomName}
                onChangeText={setNewRoomName}
                placeholder="Channel name"
                placeholderTextColor="#555"
                style={s.createInput}
                autoFocus
                editable={!roomBusy}
                onSubmitEditing={handleSubmitRoom}
              />
              <View style={s.createActions}>
                <TouchableOpacity
                  style={s.createCancelBtn}
                  onPress={() => { setCreatingRoom(false); setNewRoomName(''); }}
                  disabled={roomBusy}
                >
                  <Text style={s.createCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.createConfirmBtn, (!newRoomName.trim() || roomBusy) && s.createConfirmBtnDisabled]}
                  onPress={handleSubmitRoom}
                  disabled={roomBusy || !newRoomName.trim()}
                >
                  {roomBusy
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={s.createConfirmText}>Create</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            /* ── Channel list ── */
            <ScrollView style={s.drawerScroll} showsVerticalScrollIndicator={false}>
              <Text style={s.sectionLabel}>CHANNELS</Text>

              {orgRooms.map(room => (
                <TouchableOpacity
                  key={room.roomId}
                  style={[s.channelRow, activeRoomId === room.roomId && s.channelRowActive]}
                  onPress={() => switchRoom(room.roomId, room.name)}
                >
                  <Text style={[s.channelText, activeRoomId === room.roomId && s.channelTextActive]}>
                    # {room.name}
                  </Text>
                </TouchableOpacity>
              ))}

              <TouchableOpacity
                style={s.newChannelRow}
                onPress={() => { setNewRoomName(''); setCreatingRoom(true); }}
              >
                <Text style={s.newChannelText}>+ New channel</Text>
              </TouchableOpacity>

            </ScrollView>
          )}
        </Animated.View>
      </Modal>

      {/* Create channel modal */}
      <Modal
        visible={creatingRoom}
        transparent
        animationType="fade"
        onRequestClose={() => setCreatingRoom(false)}
      >
        <Pressable style={[s.modalOverlay, StyleSheet.absoluteFill]} onPress={() => { if (!roomBusy) setCreatingRoom(false); }} />
        <View style={s.modalPanel}>
          <Text style={s.modalTitle}>Create Channel</Text>
          <TextInput
            value={newRoomName}
            onChangeText={setNewRoomName}
            placeholder="Channel name"
            placeholderTextColor="#666"
            style={s.modalInput}
            autoFocus
            editable={!roomBusy}
            onSubmitEditing={handleSubmitRoom}
          />
          <View style={s.modalActions}>
            <TouchableOpacity
              style={s.modalCancelBtn}
              onPress={() => setCreatingRoom(false)}
              disabled={roomBusy}
            >
              <Text style={s.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.modalCreateBtn}
              onPress={handleSubmitRoom}
              disabled={roomBusy || !newRoomName.trim()}
            >
              {roomBusy
                ? <ActivityIndicator color="#000" />
                : <Text style={s.modalCreateText}>Create</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Org search + members panel */}
      <OrgSearchPanel
        visible={isSearchOpen}
        orgId={orgId}
        rooms={orgRooms}
        activeRoomName={activeRoomName}
        onClose={() => setIsSearchOpen(false)}
        onNavigateInvite={() => navigation.navigate('Invite', { orgId, orgName })}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0a0a0a' },
  center:       { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messages:     { flex: 1 },
  messagesList: { paddingVertical: 12 },
  emptyMessages:{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText:    { color: '#555', fontSize: 14 },

  headerBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },

  // Edge swipe zone
  edgeZone: { position: 'absolute', top: 0, bottom: 0, left: 0, width: EDGE_HIT_WIDTH, zIndex: 10 },

  // Dim overlay
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', zIndex: 20 },

  // Drawer
  drawer:       { position: 'absolute', top: 0, bottom: 0, left: 0, width: DRAWER_WIDTH, backgroundColor: '#111', zIndex: 30 },
  orgInfo:      { paddingHorizontal: 16, paddingVertical: 12 },
  orgInfoRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  orgName:      { color: '#fff', fontSize: 17, fontWeight: '700', flex: 1 },
  memberCount:  { color: '#666', fontSize: 12, marginTop: 2 },
  settingsBtn:  { width: 30, height: 30, borderRadius: 15, backgroundColor: '#1e1e1e', alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  settingsBtnText: { color: '#888', fontSize: 16 },
  drawerScroll: { flex: 1 },

  sectionLabel: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  sectionDivider: { height: 1, backgroundColor: '#1a1a1a', marginHorizontal: 16, marginTop: 12 },

  channelRow:       { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 6, marginHorizontal: 8 },
  channelRowActive: { backgroundColor: '#1e1e1e' },
  channelText:      { color: '#777', fontSize: 15 },
  channelTextActive:{ color: '#fff', fontWeight: '600' },
  newChannelRow:       { paddingHorizontal: 16, paddingVertical: 9, marginHorizontal: 8 },
  newChannelText:      { color: '#444', fontSize: 14 },

  // Modal
  modalOverlay:    { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  modalPanel:      { position: 'absolute', left: 24, right: 24, top: '40%', backgroundColor: '#111', borderRadius: 14, padding: 20 },
  modalTitle:      { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  modalInput:      { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#333', fontSize: 15, marginBottom: 16 },
  modalActions:    { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  modalCancelBtn:  { backgroundColor: '#222', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  modalCancelText: { color: '#fff', fontWeight: '600' },
  modalCreateBtn:  { backgroundColor: '#3b82f6', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, minWidth: 72, alignItems: 'center' },
  modalCreateText: { color: '#fff', fontWeight: '700' },

  // Inline create form (in drawer)
  createForm:      { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  createInput:     { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#333', fontSize: 15, marginBottom: 12 },
  createActions:   { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  createCancelBtn: { backgroundColor: '#222', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  createCancelText:{ color: '#fff', fontWeight: '600' },
  createConfirmBtn:{ backgroundColor: '#3b82f6', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, minWidth: 72, alignItems: 'center' },
  createConfirmBtnDisabled: { backgroundColor: '#1e3a5f', opacity: 0.6 },
  createConfirmText:{ color: '#fff', fontWeight: '700' },
});

import React, { useState, useEffect, useRef, useMemo } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';
import { SheetManager } from 'react-native-actions-sheet';
import { Menu, Search, Calendar } from 'lucide-react-native';
import { useOrgsStore } from '../stores/useOrgsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useProfileStore } from '../stores/useProfileStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useOrgWelcomeStore } from '../stores/useOrgWelcomeStore';
import { useSyncStore } from '../stores/useSyncStore';
import { ChannelMessage } from '../components/ChannelMessage';
import { MessageComposer } from '../components/MessageComposer';
import { extractMentions } from '../components/MessageText';
import { OrgSearchPanel } from '../components/OrgSearchPanel';
import { OrgEventsPanel } from '../components/OrgEventsPanel';
import { DebugConnectionPanel } from '../components/DebugConnectionPanel';
import { listOrgMembers, listIcedMembers } from '../ffi/gardensCore';
import { BlobImage } from '../components/BlobImage';
import { DefaultCoverShader } from '../components/DefaultCoverShader';
import { parseCustomEmoji } from '../utils/customEmoji';

const DRAWER_WIDTH = 280;
const EDGE_HIT_WIDTH = 20;
const SNAP_THRESHOLD = DRAWER_WIDTH * 0.3;
const VEL_THRESHOLD = 0.5;

// ─── Banner component ─────────────────────────────────────────────────────────

function OrgBanner({ orgName, coverBlobId, avatarBlobId }: { orgName: string; coverBlobId?: string | null; avatarBlobId?: string | null }) {
  const initials = orgName.slice(0, 2).toUpperCase();

  return (
    <View style={bannerStyles.root}>
      {coverBlobId ? (
        <BlobImage blobHash={coverBlobId} style={bannerStyles.coverImage} />
      ) : (
        <DefaultCoverShader width={DRAWER_WIDTH} height={120} />
      )}
      <View style={bannerStyles.content}>
        {avatarBlobId ? (
          <BlobImage blobHash={avatarBlobId} style={[bannerStyles.avatar, { borderColor: '#111' }]} />
        ) : (
          <View style={[bannerStyles.avatar, { borderColor: '#111' }]}>
            <Text style={bannerStyles.avatarText}>{initials}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  root: { height: 120, overflow: 'hidden' },
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
  const { messages, reactions, fetchMessages, sendMessage, deleteMessage, toggleReaction } = useMessagesStore();
  const { myProfile, profileCache, fetchProfile, profilePicUri } = useProfileStore();
  const { dismissed, load: loadWelcome, setDismissed } = useOrgWelcomeStore();
  const { subscribe: syncSubscribe, unsubscribe: syncUnsubscribe, opTick } = useSyncStore();

  const [activeRoomId, setActiveRoomId]     = useState<string | null>(null);
  const [activeRoomName, setActiveRoomName] = useState('');
  const [activePane, setActivePane]         = useState<'room' | 'events'>('room');
  const [memberCount, setMemberCount]       = useState(0);
  const [isAdmin, setIsAdmin]               = useState(false);
  const [loadingRooms, setLoadingRooms]     = useState(true);
  const [loadingMsgs, setLoadingMsgs]       = useState(false);
  const [mentionPrefill, setMentionPrefill] = useState<string | null>(null);
  const [replyingTo, setReplyingTo]         = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen]     = useState(false);
  const [isSearchOpen, setIsSearchOpen]     = useState(false);
  const [creatingRoom, setCreatingRoom]     = useState(false);
  const [newRoomName, setNewRoomName]       = useState('');
  const [roomBusy, setRoomBusy]             = useState(false);
  const [showWelcome, setShowWelcome]       = useState(false);
  const [icedMap, setIcedMap]               = useState<Record<string, number>>({});
  const [memberUsernames, setMemberUsernames] = useState<string[]>([]);

  const flatListRef    = useRef<FlatList>(null);
  const activeRoomRef  = useRef<string | null>(null);
  const drawerX       = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const drawerIsOpen  = useRef(false); // ref for PanResponder closures
  const isNearBottom  = useRef(true);

  const orgRooms   = rooms[orgId] || [];
  const welcomeText = org?.welcomeText?.trim() ?? '';
  const isWelcomeDismissed = dismissed[orgId] ?? false;
  const customEmojiList = parseCustomEmoji(org?.customEmojiJson);
  const customEmojis = customEmojiList.reduce<Record<string, { blobId: string; mimeType: string; roomId: string | null }>>(
    (acc, e) => {
      if (e?.code && e?.blobId) acc[e.code] = { blobId: e.blobId, mimeType: e.mimeType, roomId: e.roomId };
      return acc;
    },
    {},
  );
  const quickReactions = ['👍', '😂', '❤️', '🔥', '👏', ...customEmojiList.map(e => e.code)];
  const messageList = activeRoomId ? (messages[activeRoomId] || []) : [];
  const messageByIdRef = useRef<Map<string, typeof messageList[number]>>(new Map());
  useEffect(() => {
    messageByIdRef.current = new Map(messageList.map(m => [m.messageId, m]));
  }, [messageList]);

  const mentionCandidates = useMemo(() => {
    const names = new Set<string>();
    memberUsernames.forEach(n => names.add(n));
    Object.values(profileCache).forEach(p => {
      if (p?.username) names.add(p.username);
    });
    if (myProfile?.username) names.add(myProfile.username);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [memberUsernames, profileCache, myProfile]);

  const channelCandidates = useMemo(
    () => (orgRooms.map(r => r.name)).sort((a, b) => a.localeCompare(b)),
    [orgRooms],
  );

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
    const headerTitle = activePane === 'events'
      ? 'Events'
      : (activeRoomName ? `#${activeRoomName}` : orgName);
    navigation.setOptions({
      title: headerTitle,
      headerLeft: () => (
        <TouchableOpacity style={[s.headerBtn, { marginRight: 8 }]} onPress={openDrawer}>
          <Menu size={20} color="#fff" />
        </TouchableOpacity>
      ),
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {activePane === 'room' && (
            <TouchableOpacity style={[s.headerBtn, { marginRight: 8 }]} onPress={() => setIsSearchOpen(true)}>
              <Search size={18} color="#fff" />
            </TouchableOpacity>
          )}
          <DebugConnectionPanel />
        </View>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePane, activeRoomName, navigation, orgId, orgName]);

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    loadInitial();
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  useEffect(() => {
    loadWelcome(orgId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  useEffect(() => {
    if (welcomeText && !isWelcomeDismissed) {
      setShowWelcome(true);
    }
  }, [welcomeText, isWelcomeDismissed]);

  // Re-fetch messages when the sync worker delivers a new op for this room
  useEffect(() => {
    if (opTick > 0 && activeRoomId) {
      fetchMessages(activeRoomId, null).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opTick]);

  useFocusEffect(
    React.useCallback(() => {
      if (activeRoomId) {
        fetchMessages(activeRoomId, null).catch(() => {});
        syncSubscribe(activeRoomId);
      }
      syncSubscribe(orgId); // org-level ops (events, emoji, member changes)
      listIcedMembers(orgId)
        .then((list) => {
          const map: Record<string, number> = {};
          list.forEach(i => { map[i.publicKey] = i.icedUntil; });
          setIcedMap(map);
        })
        .catch(() => {});
      return () => {
        if (activeRoomId) syncUnsubscribe(activeRoomId);
        syncUnsubscribe(orgId);
      };
    }, [activeRoomId, orgId]),
  );

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
        try {
          const iced = await listIcedMembers(orgId);
          const map: Record<string, number> = {};
          iced.forEach(i => { map[i.publicKey] = i.icedUntil; });
          setIcedMap(map);
        } catch {}
        try {
          const profiles = await Promise.all(members.map(m => fetchProfile(m.publicKey)));
          const names = profiles
            .map(p => p?.username)
            .filter((name): name is string => !!name);
          setMemberUsernames(names);
        } catch {}
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
    // Unsubscribe previous room, subscribe new one via TopicDO WebSocket
    if (activeRoomRef.current) syncUnsubscribe(activeRoomRef.current);
    syncSubscribe(roomId);
    activeRoomRef.current = roomId;

    setActiveRoomId(roomId);
    setActiveRoomName(roomName);
    setActivePane('room');
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

  function switchEvents() {
    setActivePane('events');
    closeDrawer();
  }

  // ── Send message ────────────────────────────────────────────────────────────

  async function handleSend(text: string) {
    if (!activeRoomId) return;
    try {
      await sendMessage({
        roomId: activeRoomId,
        contentType: 'text',
        textContent: text,
        mentions: extractMentions(text),
        replyTo: replyingTo ?? undefined,
      });
      setReplyingTo(null);
      await fetchMessages(activeRoomId, null);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      const msg = err?.message || 'Failed to send';
      if (msg.startsWith('cooldown:')) {
        const secs = msg.replace('cooldown:', '').replace('s', '');
        Alert.alert('Slow mode', `Please wait ${secs}s before sending again.`);
      } else if (msg.startsWith('iced:')) {
        const secs = msg.replace('iced:', '').replace('s', '');
        Alert.alert('You are iced', `You can send again in ${secs}s.`);
      } else {
        Alert.alert('Error', msg);
      }
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
      const msg = err?.message || 'Failed to send';
      if (msg.startsWith('cooldown:')) {
        const secs = msg.replace('cooldown:', '').replace('s', '');
        Alert.alert('Slow mode', `Please wait ${secs}s before sending again.`);
      } else if (msg.startsWith('iced:')) {
        const secs = msg.replace('iced:', '').replace('s', '');
        Alert.alert('You are iced', `You can send again in ${secs}s.`);
      } else {
        Alert.alert('Error', msg);
      }
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
      const msg = err?.message || 'Failed to send';
      if (msg.startsWith('cooldown:')) {
        const secs = msg.replace('cooldown:', '').replace('s', '');
        Alert.alert('Slow mode', `Please wait ${secs}s before sending again.`);
      } else if (msg.startsWith('iced:')) {
        const secs = msg.replace('iced:', '').replace('s', '');
        Alert.alert('You are iced', `You can send again in ${secs}s.`);
      } else {
        Alert.alert('Error', msg);
      }
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
      const msg = err?.message || 'Failed to send';
      if (msg.startsWith('cooldown:')) {
        const secs = msg.replace('cooldown:', '').replace('s', '');
        Alert.alert('Slow mode', `Please wait ${secs}s before sending again.`);
      } else if (msg.startsWith('iced:')) {
        const secs = msg.replace('iced:', '').replace('s', '');
        Alert.alert('You are iced', `You can send again in ${secs}s.`);
      } else {
        Alert.alert('Error', msg);
      }
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
      {activePane === 'events' ? (
        <OrgEventsPanel orgId={orgId} orgName={orgName} rooms={orgRooms} />
      ) : loadingMsgs ? (
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
              const isOwn = item.authorKey === myProfile?.publicKey;
              const authorAvatarBlobId = (isOwn ? myProfile?.avatarBlobId : profile?.avatarBlobId) ?? null;
              const authorAvatarUri = isOwn ? profilePicUri : null;
              const replyToMsg = item.replyTo ? messageByIdRef.current.get(item.replyTo) : null;
              const replyProfile = replyToMsg ? profileCache[replyToMsg.authorKey] : null;
              const replyToUsername = replyToMsg
                ? (replyProfile?.username ?? replyToMsg.authorKey.slice(0, 8))
                : null;
              const replyToPreview = replyToMsg && replyToUsername ? {
                username: replyToUsername,
                isDeleted: replyToMsg.isDeleted,
                text: replyToMsg.textContent
                  ?? (replyToMsg.contentType === 'image' ? 'Image'
                    : replyToMsg.contentType === 'audio' ? 'Voice message'
                    : replyToMsg.contentType === 'gif' ? 'GIF'
                    : replyToMsg.contentType === 'video' ? 'Video'
                    : 'Message'),
              } : null;
              const myKey = myProfile?.publicKey ?? useAuthStore.getState().keypair?.publicKeyHex ?? '';
              const canDelete = item.authorKey === myProfile?.publicKey || isAdmin;
              const icedUntil = icedMap[item.authorKey];
              const isIced = typeof icedUntil === 'number' && icedUntil > Date.now() * 1000;
              const reactionList = reactions[item.messageId] || [];
              const summary = Object.values(
                reactionList.reduce<Record<string, { emoji: string; count: number; reactedByMe: boolean }>>((acc, r) => {
                  const entry = acc[r.emoji] ?? { emoji: r.emoji, count: 0, reactedByMe: false };
                  entry.count += 1;
                  if (r.reactorKey === myKey) entry.reactedByMe = true;
                  acc[r.emoji] = entry;
                  return acc;
                }, {})
              );

              return (
                <ChannelMessage
                  message={item}
                  isOwnMessage={isOwn}
                  isGrouped={isGrouped}
                  authorUsername={authorUsername}
                  authorAvatarBlobId={authorAvatarBlobId}
                  authorAvatarUri={authorAvatarUri}
                  authorIced={isIced}
                  replyToPreview={replyToPreview}
                  reactions={summary}
                  customEmojis={customEmojis}
                  onToggleReaction={async (emoji) => {
                    if (!myKey) return;
                    await toggleReaction(item.messageId, emoji, myKey, item.roomId);
                  }}
                  onReply={() => {
                    setReplyingTo(item.messageId);
                    setMentionPrefill(`@${authorUsername} `);
                  }}
                  onLongPress={() => {
                    SheetManager.show('message-actions-sheet', {
                      payload: {
                        canDelete: canDelete && !item.isDeleted,
                        onReply: () => {
                          setReplyingTo(item.messageId);
                          setMentionPrefill(`@${authorUsername} `);
                        },
                        quickReactions,
                        customEmojis,
                        onReact: async (emoji: string) => {
                          if (!myKey) return;
                          await toggleReaction(item.messageId, emoji, myKey, item.roomId);
                        },
                        onDelete: async () => {
                          Alert.alert(
                            'Delete Message',
                            'Are you sure you want to delete this message?',
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Delete',
                                style: 'destructive',
                                onPress: async () => {
                                  try {
                                    await deleteMessage(item.messageId, orgId);
                                  } catch (err: any) {
                                    Alert.alert('Error', err.message || 'Failed to delete message');
                                  }
                                },
                              },
                            ]
                          );
                        },
                      },
                    });
                  }}
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
            mentionCandidates={mentionCandidates}
            channelCandidates={channelCandidates}
            prefillText={mentionPrefill}
            onPrefillApplied={() => setMentionPrefill(null)}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            customEmojiCodes={customEmojiList.map(e => e.code)}
            customEmojis={customEmojis}
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
          <OrgBanner orgName={orgName} coverBlobId={org?.coverBlobId} avatarBlobId={org?.avatarBlobId} />

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

          {welcomeText ? (
            <View style={s.welcomeCard}>
              <Text style={s.welcomeTitle}>Welcome</Text>
              <Text style={s.welcomeBody} numberOfLines={4}>
                {welcomeText}
              </Text>
            </View>
          ) : null}

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
              <TouchableOpacity
                style={[s.channelRow, activePane === 'events' && s.channelRowActive]}
                onPress={switchEvents}
              >
                <View style={s.channelRowContent}>
                  <Calendar size={16} color={activePane === 'events' ? '#fff' : '#777'} />
                  <Text style={[s.channelText, activePane === 'events' && s.channelTextActive]}>
                    Events
                  </Text>
                </View>
              </TouchableOpacity>

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

      {/* Welcome modal (first join) */}
      <Modal
        visible={showWelcome}
        transparent
        animationType="fade"
        onRequestClose={async () => {
          await setDismissed(orgId, true);
          setShowWelcome(false);
        }}
      >
        <Pressable
          style={[s.modalOverlay, StyleSheet.absoluteFill]}
          onPress={async () => {
            await setDismissed(orgId, true);
            setShowWelcome(false);
          }}
        />
        <View style={s.welcomeModal}>
          <Text style={s.welcomeModalTitle}>Welcome to {orgName}</Text>
          <Text style={s.welcomeModalBody}>{welcomeText}</Text>
          <TouchableOpacity
            style={s.welcomeModalBtn}
            onPress={async () => {
              await setDismissed(orgId, true);
              setShowWelcome(false);
            }}
          >
            <Text style={s.welcomeModalBtnText}>Got it</Text>
          </TouchableOpacity>
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

  welcomeCard: {
    marginHorizontal: 12,
    marginBottom: 6,
    backgroundColor: '#0f0f0f',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#1a1a1a',
  },
  welcomeTitle: { color: '#bbb', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 },
  welcomeBody: { color: '#cfcfcf', fontSize: 13, lineHeight: 18 },

  sectionLabel: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  sectionDivider: { height: 1, backgroundColor: '#1a1a1a', marginHorizontal: 16, marginTop: 12 },

  channelRow:       { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 6, marginHorizontal: 8 },
  channelRowActive: { backgroundColor: '#1e1e1e' },
  channelRowContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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

  welcomeModal: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: '30%',
    backgroundColor: '#111',
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1d1d1d',
  },
  welcomeModalTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  welcomeModalBody: { color: '#c9c9c9', fontSize: 14, lineHeight: 20, marginBottom: 16 },
  welcomeModalBtn: { backgroundColor: '#3b82f6', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, alignSelf: 'flex-end' },
  welcomeModalBtnText: { color: '#fff', fontWeight: '700' },

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

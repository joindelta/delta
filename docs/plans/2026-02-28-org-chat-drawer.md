# Org Chat Drawer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the `OrgScreen` tab-bar + `RoomChatScreen` two-step navigation with a single `OrgChatScreen` that embeds the channel list in a Discord-style left-edge-swipe drawer.

**Architecture:** A new `OrgChatScreen` merges channel selection and chat into one screen. The drawer is an `Animated.View` with `translateX`, opened exclusively by swiping right from a 20px invisible edge zone, and closed by tapping the dim overlay or swiping left on the drawer. Channel switching swaps the active room in-place (no stack push). The old `Org` and `RoomChat` nav routes are removed; `OrgChat` replaces both.

**Tech Stack:** React Native `Animated` + `PanResponder`, `useOrgsStore`, `useMessagesStore`, existing `MessageBubble` / `MessageComposer` components.

---

### Task 1: Create `OrgChatScreen.tsx`

**Files:**
- Create: `app/src/screens/OrgChatScreen.tsx`

**Step 1: Write the file**

```tsx
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
  Dimensions,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useOrgsStore } from '../stores/useOrgsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useProfileStore } from '../stores/useProfileStore';
import { MessageBubble } from '../components/MessageBubble';
import { MessageComposer } from '../components/MessageComposer';
import { listOrgMembers } from '../ffi/deltaCore';

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

function OrgBanner({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [bg1, bg2] = orgGradient(orgId);
  const initials = orgName.slice(0, 2).toUpperCase();
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
  content: { flex: 1, justifyContent: 'flex-end', padding: 14 },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});

// ─── Main screen ─────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<any, 'OrgChat'>;

export function OrgChatScreen({ route, navigation }: Props) {
  const { orgId, orgName } = route.params as { orgId: string; orgName: string };

  const { rooms, fetchRooms, createRoom } = useOrgsStore();
  const { messages, fetchMessages, sendMessage } = useMessagesStore();
  const { myProfile } = useProfileStore();

  const [activeRoomId, setActiveRoomId]     = useState<string | null>(null);
  const [activeRoomName, setActiveRoomName] = useState('');
  const [memberCount, setMemberCount]       = useState(0);
  const [loadingRooms, setLoadingRooms]     = useState(true);
  const [loadingMsgs, setLoadingMsgs]       = useState(false);
  const [replyingTo, setReplyingTo]         = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen]     = useState(false);
  const [creatingRoom, setCreatingRoom]     = useState(false);
  const [newRoomName, setNewRoomName]       = useState('');
  const [roomBusy, setRoomBusy]             = useState(false);

  const flatListRef  = useRef<FlatList>(null);
  const drawerX      = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const drawerIsOpen = useRef(false); // ref for PanResponder closures

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
        const val = Math.min(0, gs.dx);
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
      title: activeRoomName ? `${orgName}  ·  #${activeRoomName}` : orgName,
      headerRight: () => (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            style={s.headerBtn}
            onPress={() => navigation.navigate('MemberList', { orgId, orgName })}
          >
            <Text style={s.headerBtnText}>👥</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.headerBtn}
            onPress={() => navigation.navigate('Invite', { orgId, orgName })}
          >
            <Text style={s.headerBtnText}>➕</Text>
          </TouchableOpacity>
        </View>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomName]);

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    loadInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function loadInitial() {
    setLoadingRooms(true);
    try {
      await fetchRooms(orgId);
      const fresh = useOrgsStore.getState().rooms[orgId] || [];
      if (fresh.length > 0) {
        await switchRoom(fresh[0].roomId, fresh[0].name);
      }
      try {
        const members = await listOrgMembers(orgId);
        setMemberCount(members.length);
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
            renderItem={({ item }) => (
              <MessageBubble
                message={item}
                isOwnMessage={item.authorKey === myProfile?.publicKey}
                onReply={() => setReplyingTo(item.messageId)}
                onLongPress={() =>
                  Alert.alert('Message Actions', 'Choose an action', [
                    { text: 'Reply', onPress: () => setReplyingTo(item.messageId) },
                    { text: 'Cancel', style: 'cancel' },
                  ])
                }
              />
            )}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={
              <View style={s.emptyMessages}>
                <Text style={s.emptyText}>No messages yet. Say hello!</Text>
              </View>
            }
          />
          <MessageComposer
            onSend={handleSend}
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

      {/* Dimming overlay — tap to close */}
      {isDrawerOpen && (
        <Animated.View style={[s.overlay, { opacity: overlayOpacity }]} pointerEvents="auto">
          <Pressable style={StyleSheet.absoluteFill} onPress={closeDrawer} />
        </Animated.View>
      )}

      {/* Drawer panel */}
      <Animated.View
        style={[s.drawer, { transform: [{ translateX: drawerX }] }]}
        {...drawerPan.panHandlers}
      >
        <OrgBanner orgId={orgId} orgName={orgName} />

        <View style={s.orgInfo}>
          <Text style={s.orgName}>{orgName}</Text>
          {memberCount > 0 && (
            <Text style={s.memberCount}>
              {memberCount} member{memberCount !== 1 ? 's' : ''}
            </Text>
          )}
        </View>

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

          <View style={s.sectionDivider} />
          <Text style={s.sectionLabel}>MEMBERS</Text>

          <TouchableOpacity
            style={s.channelRow}
            onPress={() => { closeDrawer(); navigation.navigate('MemberList', { orgId, orgName }); }}
          >
            <Text style={s.channelText}>Manage members</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.channelRow}
            onPress={() => { closeDrawer(); navigation.navigate('Invite', { orgId, orgName }); }}
          >
            <Text style={s.channelText}>Generate invite</Text>
          </TouchableOpacity>
        </ScrollView>
      </Animated.View>

      {/* Create channel modal */}
      <Modal
        visible={creatingRoom}
        transparent
        animationType="fade"
        onRequestClose={() => setCreatingRoom(false)}
      >
        <Pressable style={s.modalOverlay} onPress={() => { if (!roomBusy) setCreatingRoom(false); }}>
          <View />
        </Pressable>
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
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0a0a0a' },
  center:       { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messages:     { flex: 1 },
  messagesList: { paddingVertical: 12 },
  emptyMessages:{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText:    { color: '#555', fontSize: 14 },

  headerBtn:     { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: 18 },

  // Edge swipe zone
  edgeZone: { position: 'absolute', top: 0, bottom: 0, left: 0, width: EDGE_HIT_WIDTH, zIndex: 10 },

  // Dim overlay
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', zIndex: 20 },

  // Drawer
  drawer:       { position: 'absolute', top: 0, bottom: 0, left: 0, width: DRAWER_WIDTH, backgroundColor: '#111', zIndex: 30 },
  orgInfo:      { paddingHorizontal: 16, paddingVertical: 12 },
  orgName:      { color: '#fff', fontSize: 17, fontWeight: '700' },
  memberCount:  { color: '#666', fontSize: 12, marginTop: 2 },
  drawerScroll: { flex: 1 },

  sectionLabel: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  sectionDivider: { height: 1, backgroundColor: '#1a1a1a', marginHorizontal: 16, marginTop: 12 },

  channelRow:       { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 6, marginHorizontal: 8 },
  channelRowActive: { backgroundColor: '#1e1e1e' },
  channelText:      { color: '#777', fontSize: 15 },
  channelTextActive:{ color: '#fff', fontWeight: '600' },
  newChannelRow:    { paddingHorizontal: 16, paddingVertical: 9, marginHorizontal: 8 },
  newChannelText:   { color: '#444', fontSize: 14 },

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
});
```

**Step 2: Verify the file exists**

```bash
ls app/src/screens/OrgChatScreen.tsx
```

Expected: file listed with no error.

**Step 3: Commit**

```bash
git add app/src/screens/OrgChatScreen.tsx
git commit -m "feat: add OrgChatScreen with Discord-style left-edge swipe drawer"
```

---

### Task 2: Update `RootNavigator.tsx`

**Files:**
- Modify: `app/src/navigation/RootNavigator.tsx`

**Step 1: Add `OrgChat` to `MainStackParamList` and remove `Org` + `RoomChat`**

In `MainStackParamList`, replace:
```ts
Org: { orgId: string; orgName: string };
RoomChat: { roomId: string; roomName: string };
```
with:
```ts
OrgChat: { orgId: string; orgName: string };
```

**Step 2: Add the import**

At the top of the file, replace:
```ts
import { OrgScreen } from '../screens/OrgScreen';
import { RoomChatScreen } from '../screens/RoomChatScreen';
```
with:
```ts
import { OrgChatScreen } from '../screens/OrgChatScreen';
```

**Step 3: Swap the screen registrations**

In `MainNavigator`, remove:
```tsx
<MainStack.Screen
  name="Org"
  component={OrgScreen}
  options={{ title: 'Organization', headerShown: true }}
/>
<MainStack.Screen
  name="RoomChat"
  component={RoomChatScreen}
  options={({ route }) => ({
    title: `#${(route.params as any).roomName}`,
    headerShown: true,
  })}
/>
```

Add in their place:
```tsx
<MainStack.Screen
  name="OrgChat"
  component={OrgChatScreen}
  options={{ headerShown: true }}
/>
```

**Step 4: Commit**

```bash
git add app/src/navigation/RootNavigator.tsx
git commit -m "feat: swap Org+RoomChat routes for OrgChat in navigator"
```

---

### Task 3: Update `HomeScreen.tsx`

**Files:**
- Modify: `app/src/screens/HomeScreen.tsx`

**Step 1: Change the org navigation call**

In `renderItem`, find the org `TouchableOpacity` `onPress`:
```ts
onPress={() => navigation.navigate('Org', { orgId: item.orgId, orgName: item.name })}
```

Change to:
```ts
onPress={() => navigation.navigate('OrgChat', { orgId: item.orgId, orgName: item.name })}
```

**Step 2: Commit**

```bash
git add app/src/screens/HomeScreen.tsx
git commit -m "feat: navigate to OrgChat instead of Org from HomeScreen"
```

---

### Task 4: Remove `OrgScreen.tsx` and verify build

**Files:**
- Delete: `app/src/screens/OrgScreen.tsx`

**Step 1: Delete the old file**

```bash
rm app/src/screens/OrgScreen.tsx
```

**Step 2: Check for any remaining references**

```bash
grep -r "OrgScreen\|from.*OrgScreen" app/src --include="*.ts" --include="*.tsx"
```

Expected: no output (zero references remaining).

Also check for `RoomChatScreen` references (should only be in `RoomChatScreen.tsx` itself, which we keep for potential DM use — but verify it's not imported anywhere in the navigator anymore):
```bash
grep -r "RoomChatScreen\|RoomChat" app/src/navigation --include="*.ts" --include="*.tsx"
```

Expected: no output.

**Step 3: Run Metro bundler to verify no import errors**

```bash
cd app && npm start -- --reset-cache
```

Expected: Metro starts cleanly with no module resolution errors.

**Step 4: Build and run on Android**

```bash
cd app && npm run android
```

Expected: app builds and launches. Tapping an org from Home should open `OrgChatScreen` on the first room. Swiping right from the left edge should slide the channel drawer in.

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: remove OrgScreen, complete Discord-style org chat drawer"
```

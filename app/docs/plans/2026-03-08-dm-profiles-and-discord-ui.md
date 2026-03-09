# DM Profiles & Discord-Style Chat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Exchange profiles privately over encrypted DM channels, show them in the home screen and conversation UI, and upgrade the 1:1 conversation UI to match the Discord-style layout used in OrgChatScreen.

**Architecture:** A hidden `contentType: 'profile'` DM message carries `{ username, avatarBlobId }` JSON and is sent automatically when creating a thread or making a first reply. On receive, `fetchMessages` extracts these messages, writes to AsyncStorage KV (`gardens.dm_profile:<publicKey>`), and filters them from the rendered list. `fetchProfile` gains a new KV lookup step before native/pkarr. ConversationScreen swaps `MessageBubble` for `ChannelMessage` with grouping + reply-preview logic matching OrgChatScreen.

**Tech Stack:** React Native, Zustand, AsyncStorage (`@react-native-async-storage/async-storage`), existing `ChannelMessage` component, existing `sendMessage` native bridge.

---

### Task 1: Add `'profile'` contentType and create DM profile KV store

**Files:**
- Modify: `src/stores/useMessagesStore.ts`
- Create: `src/stores/useDmProfileStore.ts`

**Step 1: Add `'profile'` to the `Message` contentType union in `useMessagesStore.ts`**

In `src/stores/useMessagesStore.ts` at line 10, change:
```ts
contentType: 'text' | 'audio' | 'image' | 'gif' | 'video' | 'embed';
```
to:
```ts
contentType: 'text' | 'audio' | 'image' | 'gif' | 'video' | 'embed' | 'profile';
```

Also update the `sendMessage` params type at line 36:
```ts
contentType: Message['contentType'];
```
(No change needed — it already derives from the union.)

**Step 2: Create `src/stores/useDmProfileStore.ts`**

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'gardens.dm_profile:';

export interface DmProfile {
  publicKey: string;
  username: string;
  avatarBlobId: string | null;
  cachedAt: number;
}

export async function getDmProfile(publicKey: string): Promise<DmProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + publicKey);
    if (!raw) return null;
    return JSON.parse(raw) as DmProfile;
  } catch {
    return null;
  }
}

export async function setDmProfile(profile: Omit<DmProfile, 'cachedAt'>): Promise<void> {
  try {
    const entry: DmProfile = { ...profile, cachedAt: Date.now() };
    await AsyncStorage.setItem(KEY_PREFIX + profile.publicKey, JSON.stringify(entry));
  } catch {
    // non-critical — silently fail
  }
}
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/jdbohrman/delta/app && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors related to the new files.

**Step 4: Commit**

```bash
git add src/stores/useMessagesStore.ts src/stores/useDmProfileStore.ts
git commit -m "feat(dm-profiles): add profile contentType and AsyncStorage KV store"
```

---

### Task 2: Extract and store profile messages in `fetchMessages`

**Files:**
- Modify: `src/stores/useMessagesStore.ts`

**Step 1: Import KV helpers at the top of `useMessagesStore.ts`**

Add after the existing imports:
```ts
import { getDmProfile, setDmProfile } from './useDmProfileStore';
import { useProfileStore } from './useProfileStore';
```

**Step 2: In `fetchMessages`, extract profile messages before storing**

Replace the `set(s => ({ messages: ...` block (lines 64–66) with:

```ts
const key = contextKey(roomId, dmThreadId);
// Split out profile-exchange messages — store them in KV, never render them.
const profileMsgs = msgs.filter(m => m.contentType === 'profile');
const visibleMsgs = msgs.filter(m => m.contentType !== 'profile');

for (const pm of profileMsgs) {
  try {
    const data = JSON.parse(pm.textContent ?? '{}') as {
      username?: string;
      avatarBlobId?: string | null;
    };
    if (data.username) {
      await setDmProfile({
        publicKey: pm.authorKey,
        username: data.username,
        avatarBlobId: data.avatarBlobId ?? null,
      });
      // Hydrate in-memory profile cache immediately
      useProfileStore.setState(s => ({
        profileCache: {
          ...s.profileCache,
          [pm.authorKey]: {
            publicKey: pm.authorKey,
            username: data.username!,
            avatarBlobId: data.avatarBlobId ?? null,
            bio: null,
            availableFor: [],
            isPublic: false,
            createdAt: pm.timestamp,
            updatedAt: pm.timestamp,
          },
        },
      }));
    }
  } catch {
    // malformed profile message — ignore
  }
}

// Oldest-first for display.
set(s => ({ messages: { ...s.messages, [key]: [...visibleMsgs].reverse() as Message[] } }));
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/jdbohrman/delta/app && npx tsc --noEmit 2>&1 | head -30
```

**Step 4: Commit**

```bash
git add src/stores/useMessagesStore.ts
git commit -m "feat(dm-profiles): extract and cache profile messages on fetchMessages"
```

---

### Task 3: Update `fetchProfile` to check KV store before network

**Files:**
- Modify: `src/stores/useProfileStore.ts`

**Step 1: Import KV helpers**

Add after the existing imports in `useProfileStore.ts`:
```ts
import { getDmProfile } from './useDmProfileStore';
```

**Step 2: Update `fetchProfile` to check KV before native and pkarr**

Replace the existing `fetchProfile` implementation (lines 74–82):

```ts
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
    const pkarrUrl = getPkarrUrl(publicKey); // "pk:<z32>"
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
```

**Step 3: Add missing imports for `getPkarrUrl` and `resolvePkarr`**

The existing import at the top of `useProfileStore.ts` is:
```ts
import {
  getMyProfile,
  getProfile,
  getBlob,
  getPkarrUrl,
  createOrUpdateProfile as dcCreateOrUpdateProfile,
  type Profile,
} from '../ffi/gardensCore';
```

Add `resolvePkarr` to that import:
```ts
import {
  getMyProfile,
  getProfile,
  getBlob,
  getPkarrUrl,
  resolvePkarr,
  createOrUpdateProfile as dcCreateOrUpdateProfile,
  type Profile,
} from '../ffi/gardensCore';
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/jdbohrman/delta/app && npx tsc --noEmit 2>&1 | head -30
```

**Step 5: Commit**

```bash
git add src/stores/useProfileStore.ts
git commit -m "feat(dm-profiles): fetchProfile checks KV store and pkarr before giving up"
```

---

### Task 4: Send profile message on thread creation and first reply

**Files:**
- Modify: `src/stores/useConversationsStore.ts`
- Modify: `src/screens/ConversationScreen.tsx`

**Step 1: Send profile message after `createConversation` in `useConversationsStore.ts`**

Import `sendMessage` and `useProfileStore` at the top:
```ts
import { sendMessage } from '../ffi/gardensCore';
import { useProfileStore } from './useProfileStore';
```

In `createConversation`, after `await get().fetchConversations()` and before the relay push, add:

```ts
// Send our profile to the new thread so the recipient can identify us
const myProfile = useProfileStore.getState().myProfile;
if (myProfile?.username) {
  const profilePayload = JSON.stringify({
    username: myProfile.username,
    avatarBlobId: myProfile.avatarBlobId ?? null,
  });
  try {
    const profileResult = await sendMessage(
      null, result.id, 'profile', profilePayload, null, null, [], null,
    );
    if (profileResult.opBytes?.length) {
      broadcastOp(result.id, profileResult.opBytes);
    }
  } catch {
    // profile message is best-effort
  }
}
```

**Step 2: Track "profile sent" per thread in AsyncStorage**

Add helpers to `src/stores/useDmProfileStore.ts`:

```ts
const PROFILE_SENT_PREFIX = 'gardens.profile_sent:';

export async function hasProfileBeenSent(threadId: string): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(PROFILE_SENT_PREFIX + threadId);
    return val === 'true';
  } catch {
    return false;
  }
}

export async function markProfileSent(threadId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(PROFILE_SENT_PREFIX + threadId, 'true');
  } catch {}
}
```

**Step 3: Send profile on first reply in `ConversationScreen.tsx`**

Import the helpers at the top:
```ts
import { hasProfileBeenSent, markProfileSent } from '../stores/useDmProfileStore';
import { sendMessage as nativeSendMessage } from '../ffi/gardensCore';
import { broadcastOp } from '../stores/useSyncStore';
```

At the start of `handleSend`, before calling `sendMessage`, add:

```ts
// Send our profile on first reply so the other party can identify us
const alreadySent = await hasProfileBeenSent(threadId);
if (!alreadySent && myProfile?.username) {
  const profilePayload = JSON.stringify({
    username: myProfile.username,
    avatarBlobId: myProfile.avatarBlobId ?? null,
  });
  try {
    const profileResult = await nativeSendMessage(
      null, threadId, 'profile', profilePayload, null, null, [], null,
    );
    if (profileResult.opBytes?.length) broadcastOp(threadId, profileResult.opBytes);
    await markProfileSent(threadId);
  } catch {
    // best-effort
  }
}
```

Do the same at the top of `handleSendBlob`, `handleSendAudio`, and `handleSendGif` (copy the same block).

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/jdbohrman/delta/app && npx tsc --noEmit 2>&1 | head -30
```

**Step 5: Commit**

```bash
git add src/stores/useConversationsStore.ts src/stores/useDmProfileStore.ts src/screens/ConversationScreen.tsx
git commit -m "feat(dm-profiles): send profile message on thread creation and first reply"
```

---

### Task 5: ConversationScreen — Discord-style UI with `ChannelMessage`

**Files:**
- Modify: `src/screens/ConversationScreen.tsx`

**Step 1: Update imports**

Replace the `MessageBubble` import with `ChannelMessage`:
```ts
import { ChannelMessage } from '../components/ChannelMessage';
```

Add `profilePicUri` to the `useProfileStore` destructure:
```ts
const { myProfile, profileCache, fetchProfile, profilePicUri } = useProfileStore();
```

**Step 2: Add `messageByIdRef` for reply preview lookups**

After the existing `flatListRef` declaration, add:
```ts
const messageByIdRef = useRef<Map<string, typeof messageList[0]>>(new Map());
useEffect(() => {
  messageByIdRef.current = new Map(messageList.map(m => [m.messageId, m]));
}, [messageList]);
```

**Step 3: Replace FlatList `renderItem` with `ChannelMessage`**

Replace the entire `renderItem` in the FlatList (lines ~215–229) with:

```tsx
renderItem={({ item, index }) => {
  const prev = index > 0 ? messageList[index - 1] : null;
  const isGrouped = prev?.authorKey === item.authorKey;
  const isOwn = item.authorKey === myProfile?.publicKey;
  const profile = profileCache[item.authorKey];
  const authorUsername = isOwn
    ? (myProfile?.username ?? item.authorKey.slice(0, 8))
    : (profile?.username ?? item.authorKey.slice(0, 8));
  const authorAvatarBlobId = isOwn
    ? (myProfile?.avatarBlobId ?? null)
    : (profile?.avatarBlobId ?? null);
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

  return (
    <ChannelMessage
      message={item}
      isOwnMessage={isOwn}
      isGrouped={isGrouped}
      authorUsername={authorUsername}
      authorAvatarBlobId={authorAvatarBlobId}
      authorAvatarUri={authorAvatarUri}
      replyToPreview={replyToPreview}
      onReply={() => handleReply(item.messageId)}
      onLongPress={() => handleLongPress(item)}
    />
  );
}}
```

**Step 4: Remove unused imports**

Remove `MessageBubble` from imports if it's no longer used anywhere in the file.

**Step 5: Verify TypeScript compiles**

```bash
cd /Users/jdbohrman/delta/app && npx tsc --noEmit 2>&1 | head -30
```

**Step 6: Commit**

```bash
git add src/screens/ConversationScreen.tsx
git commit -m "feat(conversation): swap MessageBubble for Discord-style ChannelMessage"
```

---

### Task 6: HomeScreen — last message preview and profile display

**Files:**
- Modify: `src/screens/HomeScreen.tsx`

**Step 1: Import `useMessagesStore`**

Add to the existing imports:
```ts
import { useMessagesStore } from '../stores/useMessagesStore';
```

**Step 2: Destructure `messages` in the component**

Add after the existing store hooks:
```ts
const { messages } = useMessagesStore();
```

**Step 3: Update the DM `renderItem` sub-line to show last message preview**

In `renderItem` for `item.kind === 'dm'`, replace:
```tsx
<Text style={styles.sub} numberOfLines={1}>
  {item.lastMessageAt ? 'Conversation' : 'No messages yet'}
</Text>
```

with:
```tsx
{(() => {
  const threadMsgs = messages[item.threadId] ?? [];
  const last = threadMsgs[threadMsgs.length - 1];
  let preview = 'No messages yet';
  if (last) {
    if (last.contentType === 'text' && last.textContent) {
      preview = last.textContent;
    } else if (last.contentType === 'image') {
      preview = '📷 Image';
    } else if (last.contentType === 'audio') {
      preview = '🎤 Voice message';
    } else if (last.contentType === 'gif') {
      preview = 'GIF';
    } else if (last.contentType === 'video') {
      preview = '🎥 Video';
    }
  }
  return (
    <Text style={styles.sub} numberOfLines={1}>{preview}</Text>
  );
})()}
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/jdbohrman/delta/app && npx tsc --noEmit 2>&1 | head -30
```

**Step 5: Commit**

```bash
git add src/screens/HomeScreen.tsx
git commit -m "feat(home): show last message preview for DM conversations"
```

---

### Task 7: Manual smoke test checklist

Verify each of the following by running the app on a simulator:

- [ ] Create a new DM thread — a hidden profile message is sent (check that the conversation screen shows no extra "profile" messages in the list)
- [ ] Recipient opens conversation — their name and avatar appear correctly (not a truncated key)
- [ ] HomeScreen DM rows show: username (not key), correct avatar, last message text or media type pill
- [ ] Conversation screen uses Discord-style layout: avatar + username above message, grouped messages (no avatar for consecutive messages from same sender)
- [ ] Reply previews show correctly (tap reply on a message, send a reply, check it shows the quoted content)
- [ ] Existing org chats are unaffected

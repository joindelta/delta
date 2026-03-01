# Phase 6 - Messaging UI Usage Guide

## Quick Start

The messaging UI is now fully integrated. After authentication, users land on the HomeScreen which shows all organizations and DM threads.

## User Flows

### Creating an Organization

1. Open app → Home screen
2. Tap "+" button in Organizations section
3. Enter organization name
4. Organization appears in list
5. Tap organization to open

### Creating a Room

1. Navigate to organization
2. Tap "+" in room tabs
3. Enter room name
4. Room appears in tabs
5. Tap room to open chat

### Sending Messages

**In a Room:**
1. Navigate to organization → tap room
2. Type message in composer
3. Tap send button (↑)
4. Message appears in chat

**In a DM:**
1. Home → tap "+" in Direct Messages
2. Enter recipient public key
3. Type message in composer
4. Tap send button (↑)

### Replying to Messages

**Method 1: Quick Reply**
1. Tap the reply button (↩) next to message
2. Reply bar appears above composer
3. Type reply and send

**Method 2: Long Press**
1. Long press on message
2. Select "Reply" from menu
3. Type reply and send

### Managing Members

1. Navigate to organization
2. Tap members button (👥)
3. View member list
4. Tap member to change permissions or remove
5. Tap "Add" to add new members

### Generating Invites

1. Navigate to organization
2. Tap invite button (➕)
3. Select access level and expiry
4. Tap "Generate Invite"
5. Share via QR code, NFC, or system share

## Navigation Patterns

### From Home Screen
```
Home
 ├─ Tap org → OrgScreen
 ├─ Tap DM → DMChatScreen
 ├─ Tap "+" (orgs) → Create org dialog
 ├─ Tap "+" (DMs) → Create DM dialog
 └─ Tap 🔍 → DiscoverOrgsScreen
```

### From Org Screen
```
OrgScreen
 ├─ Tap room tab → RoomChatScreen
 ├─ Tap 👥 → MemberListScreen
 ├─ Tap ➕ → InviteScreen
 └─ Tap "+" (rooms) → Create room dialog
```

### From Chat Screens
```
RoomChatScreen / DMChatScreen
 ├─ Type message → Send
 ├─ Tap reply → Reply mode
 ├─ Long press → Message actions
 └─ Back → Return to previous screen
```

## Component Usage

### MessageBubble

```typescript
import { MessageBubble } from '../components/MessageBubble';

<MessageBubble
  message={message}
  isOwnMessage={message.authorKey === myProfile?.publicKey}
  onReply={() => handleReply(message.messageId)}
  onLongPress={() => handleLongPress(message.messageId)}
/>
```

### MessageComposer

```typescript
import { MessageComposer } from '../components/MessageComposer';

<MessageComposer
  onSend={handleSend}
  placeholder="Message..."
  replyingTo={replyingTo}
  onCancelReply={() => setReplyingTo(null)}
/>
```

## Store Usage

### Fetching Messages

```typescript
import { useMessagesStore } from '../stores/useMessagesStore';

const { messages, fetchMessages } = useMessagesStore();

// For room messages
await fetchMessages(roomId, null);

// For DM messages
await fetchMessages(null, dmThreadId);

// Access messages
const messageList = messages[roomId] || [];
```

### Sending Messages

```typescript
const { sendMessage } = useMessagesStore();

// Text message in room
await sendMessage({
  roomId: 'room-id',
  contentType: 'text',
  textContent: 'Hello world',
});

// Text message in DM
await sendMessage({
  dmThreadId: 'thread-id',
  contentType: 'text',
  textContent: 'Hello',
});

// Reply to message
await sendMessage({
  roomId: 'room-id',
  contentType: 'text',
  textContent: 'Reply text',
  replyTo: 'message-id',
});
```

### Managing Organizations

```typescript
import { useOrgsStore } from '../stores/useOrgsStore';

const { orgs, rooms, fetchMyOrgs, createOrg, fetchRooms, createRoom } = useOrgsStore();

// Load user's orgs
await fetchMyOrgs();

// Create org
const orgId = await createOrg('My Org', 'community', null, false);

// Load rooms
await fetchRooms(orgId);

// Create room
const roomId = await createRoom(orgId, 'general');
```

### Managing DMs

```typescript
import { useDMStore } from '../stores/useDMStore';

const { threads, fetchThreads, createThread } = useDMStore();

// Load threads
await fetchThreads();

// Create thread
const threadId = await createThread(recipientPublicKey);
```

## Styling Guidelines

### Message Bubbles
- Own messages: Blue background (`#3b82f6`)
- Other messages: Dark gray background (`#1a1a1a`)
- Max width: 75% of screen
- Border radius: 16px
- Padding: 12px

### Composer
- Background: Dark black (`#0a0a0a`)
- Input background: Dark gray (`#1a1a1a`)
- Border radius: 18px
- Send button: Blue when active, gray when disabled

### Screens
- Background: Dark black (`#0a0a0a`)
- Cards: Dark gray (`#1a1a1a`)
- Border radius: 12px
- Consistent 16px padding

## Message Content Types

### Text Messages
```typescript
{
  contentType: 'text',
  textContent: 'Message text',
}
```

### Media Messages (Phase 7)
```typescript
// Image
{
  contentType: 'image',
  blobId: 'blob-hash',
}

// Audio
{
  contentType: 'audio',
  blobId: 'blob-hash',
}

// Video
{
  contentType: 'video',
  blobId: 'blob-hash',
}

// GIF
{
  contentType: 'gif',
  embedUrl: 'https://tenor.com/...',
}
```

## Error Handling

All async operations should be wrapped:

```typescript
try {
  await sendMessage({ ... });
} catch (err: any) {
  Alert.alert('Error', err.message || 'Failed to send message');
}
```

## Best Practices

### Performance
1. Use FlatList for message lists
2. Key messages by messageId
3. Implement pagination for large chats
4. Debounce typing indicators

### UX
1. Auto-scroll to bottom on send
2. Show loading states
3. Provide empty states
4. Handle keyboard properly
5. Show error messages

### Accessibility
1. Use semantic components
2. Provide touch targets ≥44px
3. Support VoiceOver/TalkBack
4. High contrast text
5. Clear visual hierarchy

## Keyboard Handling

### iOS
```typescript
<KeyboardAvoidingView
  behavior="padding"
  keyboardVerticalOffset={90}
>
  {/* Content */}
</KeyboardAvoidingView>
```

### Android
```typescript
<KeyboardAvoidingView behavior={undefined}>
  {/* Content */}
</KeyboardAvoidingView>
```

## Testing Tips

### Manual Testing
1. Create org → create room → send messages
2. Start DM → send messages
3. Reply to messages
4. Long press messages
5. Test keyboard behavior
6. Test empty states
7. Test error states

### Edge Cases
- Empty message (should disable send)
- Very long messages (4000 char limit)
- Rapid message sending
- Network errors
- Deleted messages
- Messages from unknown users

## Troubleshooting

### Messages not appearing
- Check if fetchMessages was called
- Verify roomId/threadId is correct
- Check network connection
- Look for errors in console

### Keyboard issues
- Verify KeyboardAvoidingView setup
- Check keyboardVerticalOffset
- Test on physical device

### Scroll issues
- Ensure FlatList ref is set
- Check onContentSizeChange handler
- Verify scrollToEnd is called

### Styling issues
- Check dark mode compatibility
- Verify color contrast
- Test on different screen sizes

## Future Enhancements

### Phase 7 (Blobs)
- Image/video messages
- Audio messages (PTT)
- GIF search
- Rich embeds

### Phase 8 (Polish)
- Emoji reactions
- @mention autocomplete
- Typing indicators
- Read receipts
- Message search
- Edit messages
- Delete messages
- Forward messages
- Pin messages

### Phase 9 (Launch)
- Push notifications
- Offline queue
- Background sync
- App badges
- Deep linking

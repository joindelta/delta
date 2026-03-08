import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Lock } from 'lucide-react-native';
import {
  View,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Text,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { MessageBubble } from '../components/MessageBubble';
import { MessageComposer } from '../components/MessageComposer';
import { extractMentions } from '../components/MessageText';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useProfileStore } from '../stores/useProfileStore';
import { sendDMPushNotification } from '../services/pushNotifications';
import { useSyncStore } from '../stores/useSyncStore';

type Props = NativeStackScreenProps<any, 'Conversation'>;

export function ConversationScreen({ route, navigation }: Props) {
  const { threadId, recipientKey } = route.params as { threadId: string; recipientKey: string };
  const { messages, fetchMessages, sendMessage, deleteMessage } = useMessagesStore();
  const { myProfile, profileCache, fetchProfile } = useProfileStore();
  const { subscribe, unsubscribe, opTick } = useSyncStore();
  const [loading, setLoading] = useState(true);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const flatListRef = useRef<FlatList>(null);

  const contextKey = threadId;
  const messageList = messages[contextKey] || [];
  const recipientProfile = profileCache[recipientKey];

  useEffect(() => {
    fetchProfile(recipientKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipientKey]);

  useEffect(() => {
    const title = recipientProfile?.username ?? recipientKey.slice(0, 10) + '…';
    navigation.setOptions({ title });
  }, [recipientProfile, recipientKey, navigation]);

  const mentionCandidates = useMemo(() => {
    const names = new Set<string>();
    const recipient = profileCache[recipientKey]?.username;
    if (recipient) names.add(recipient);
    if (myProfile?.username) names.add(myProfile.username);
    return Array.from(names);
  }, [profileCache, recipientKey, myProfile]);

  useEffect(() => {
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useFocusEffect(
    React.useCallback(() => {
      loadMessages();
      return () => {};
    }, [threadId]),
  );

  useFocusEffect(
    React.useCallback(() => {
      subscribe(threadId);
      return () => unsubscribe(threadId);
    }, [threadId, subscribe, unsubscribe]),
  );

  useEffect(() => {
    if (!loading) fetchMessages(null, threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opTick]);

  async function loadMessages() {
    setLoading(true);
    try {
      await fetchMessages(null, threadId);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }

  async function handleSend(text: string) {
    try {
      await sendMessage({
        dmThreadId: threadId,
        contentType: 'text',
        textContent: text,
        mentions: extractMentions(text),
        replyTo: replyingTo,
      });
      setReplyingTo(null);
      const senderName = myProfile?.username ?? 'Someone';
      const preview = text.length > 100 ? text.slice(0, 97) + '…' : text;
      sendDMPushNotification({ senderName, recipientKey, threadId, preview });
      await loadMessages();
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send message');
    }
  }

  async function handleSendBlob(blobId: string, _mimeType: string, contentType: 'image' | 'video') {
    try {
      await sendMessage({ dmThreadId: threadId, contentType, blobId, replyTo: replyingTo });
      setReplyingTo(null);
      await loadMessages();
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send');
    }
  }

  async function handleSendAudio(blobId: string) {
    try {
      await sendMessage({ dmThreadId: threadId, contentType: 'audio', blobId, replyTo: replyingTo });
      setReplyingTo(null);
      await loadMessages();
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send');
    }
  }

  async function handleSendGif(embedUrl: string) {
    try {
      await sendMessage({ dmThreadId: threadId, contentType: 'gif', embedUrl, replyTo: replyingTo });
      setReplyingTo(null);
      await loadMessages();
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to send');
    }
  }

  function handleReply(messageId: string) {
    setReplyingTo(messageId);
  }

  function handleLongPress(message: typeof messageList[0]) {
    const canDelete = message.authorKey === myProfile?.publicKey && !message.isDeleted;

    const actions: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'default' | 'destructive' }> = [
      { text: 'Reply', onPress: () => handleReply(message.messageId) },
    ];

    if (canDelete) {
      actions.push({
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
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
                    await deleteMessage(message.messageId);
                  } catch (err: any) {
                    Alert.alert('Error', err.message || 'Failed to delete message');
                  }
                },
              },
            ]
          );
        },
      });
    }

    actions.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert('Message Actions', 'Choose an action', actions);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.encryptionBanner}>
        <Lock size={12} color="#666" />
        <Text style={styles.encryptionText}>End-to-end encrypted</Text>
      </View>

      {messageList.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No messages yet</Text>
          <Text style={styles.emptyHint}>
            Say hi to {recipientProfile?.username ?? recipientKey.slice(0, 10) + '…'}
          </Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messageList}
          keyExtractor={item => item.messageId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const isOwn = item.authorKey === myProfile?.publicKey;
            const avatarBlobId = isOwn
              ? myProfile?.avatarBlobId ?? null
              : profileCache[item.authorKey]?.avatarBlobId ?? profileCache[recipientKey]?.avatarBlobId ?? null;
            return (
              <MessageBubble
                message={item}
                isOwnMessage={isOwn}
                avatarBlobId={avatarBlobId}
                onReply={() => handleReply(item.messageId)}
                onLongPress={() => handleLongPress(item)}
              />
            );
          }}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      <MessageComposer
        onSend={handleSend}
        onSendBlob={handleSendBlob}
        onSendAudio={handleSendAudio}
        onSendGif={handleSendGif}
        placeholder="Message..."
        mentionCandidates={mentionCandidates}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  encryptionBanner: {
    backgroundColor: '#1e3a8a',
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  encryptionText: { color: '#dbeafe', fontSize: 12, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyText: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  emptyHint: { color: '#888', fontSize: 14, textAlign: 'center' },
  list: { paddingVertical: 16 },
});

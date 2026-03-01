import React, { useState, useEffect, useRef } from 'react';
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
import { MessageBubble } from '../components/MessageBubble';
import { MessageComposer } from '../components/MessageComposer';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useProfileStore } from '../stores/useProfileStore';

type Props = NativeStackScreenProps<any, 'DMChat'>;

export function DMChatScreen({ route }: Props) {
  const { threadId, recipientKey } = route.params as { threadId: string; recipientKey: string };
  const { messages, fetchMessages, sendMessage } = useMessagesStore();
  const { myProfile } = useProfileStore();
  const [loading, setLoading] = useState(true);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const flatListRef = useRef<FlatList>(null);

  const contextKey = threadId;
  const messageList = messages[contextKey] || [];

  useEffect(() => {
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

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
        replyTo: replyingTo,
      });
      setReplyingTo(null);
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

  function handleLongPress(messageId: string) {
    Alert.alert(
      'Message Actions',
      'Choose an action',
      [
        { text: 'Reply', onPress: () => handleReply(messageId) },
        { text: 'Copy', onPress: () => Alert.alert('Coming Soon', 'Copy functionality') },
        { text: 'Delete', onPress: () => Alert.alert('Coming Soon', 'Delete functionality'), style: 'destructive' },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
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
            Start a conversation with {recipientKey.slice(0, 16)}...
          </Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messageList}
          keyExtractor={item => item.messageId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              isOwnMessage={item.authorKey === myProfile?.publicKey}
              onReply={() => handleReply(item.messageId)}
              onLongPress={() => handleLongPress(item.messageId)}
            />
          )}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      <MessageComposer
        onSend={handleSend}
        onSendBlob={handleSendBlob}
        onSendAudio={handleSendAudio}
        onSendGif={handleSendGif}
        placeholder="Message..."
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

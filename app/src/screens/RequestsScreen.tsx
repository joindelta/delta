import React, { useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SheetManager } from 'react-native-actions-sheet';
import { useConversationsStore } from '../stores/useConversationsStore';
import { useProfileStore } from '../stores/useProfileStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useSyncStore, deriveInboxTopicHex } from '../stores/useSyncStore';
import { BlobImage } from '../components/BlobImage';

type Props = NativeStackScreenProps<any, 'Requests'>;

const AVATAR_COLORS = ['#c084fc', '#f472b6', '#fb923c', '#34d399', '#60a5fa', '#a78bfa', '#f87171'];
function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function truncateKey(key: string): string {
  if (key.length <= 16) return key;
  return key.slice(0, 8) + '…' + key.slice(-6);
}

export function RequestsScreen({ navigation }: Props) {
  const { requests, fetchConversations, deleteConversation } = useConversationsStore();
  const { profileCache, fetchProfile, myProfile } = useProfileStore();
  const { keypair } = useAuthStore();
  const { subscribe, unsubscribe, opTick } = useSyncStore();
  const myKey = myProfile?.publicKey ?? keypair?.publicKeyHex ?? '';

  const inboxTopic = keypair?.publicKeyHex ? deriveInboxTopicHex(keypair.publicKeyHex) : null;

  useFocusEffect(
    useCallback(() => {
      fetchConversations().catch(() => {});
      if (!inboxTopic) return;
      subscribe(inboxTopic);
      return () => unsubscribe(inboxTopic);
    }, [inboxTopic, subscribe, unsubscribe, fetchConversations]),
  );

  useEffect(() => {
    fetchConversations().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opTick]);

  useEffect(() => {
    for (const req of requests) {
      const contactKey = req.initiatorKey === myKey ? req.recipientKey : req.initiatorKey;
      fetchProfile(contactKey);
    }
  }, [requests, myKey, fetchProfile]);

  if (!myKey) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <FlatList
        data={requests}
        keyExtractor={(r) => r.threadId}
        renderItem={({ item }) => {
          const contactKey = item.initiatorKey === myKey ? item.recipientKey : item.initiatorKey;
          const profile = profileCache[contactKey];
          const displayName = profile?.username ?? truncateKey(contactKey);
          const initials = profile?.username ? profile.username.slice(0, 2).toUpperCase() : '?';
          const color = avatarColor(contactKey);
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('Conversation', { threadId: item.threadId, recipientKey: contactKey })}
              onLongPress={() => {
                SheetManager.show('conversation-actions-sheet', {
                  payload: {
                    title: displayName,
                    onDelete: () => deleteConversation(item.threadId),
                  },
                });
              }}
            >
              {profile?.avatarBlobId ? (
                <BlobImage blobHash={profile.avatarBlobId} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, { backgroundColor: color }]}>
                  <Text style={styles.avatarText}>{initials}</Text>
                </View>
              )}
              <View style={styles.rowBody}>
                <Text style={styles.name}>{displayName}</Text>
                <Text style={styles.sub}>Tap to accept by replying</Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No requests</Text>
            <Text style={styles.emptySub}>New message requests will show up here.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  rowBody: { flex: 1 },
  name: { color: '#fff', fontSize: 15, fontWeight: '600' },
  sub: { color: '#888', fontSize: 13, marginTop: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 120, paddingHorizontal: 32 },
  emptyTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  emptySub: { color: '#666', fontSize: 13, textAlign: 'center', marginTop: 6 },
});

import React, { useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SheetManager } from 'react-native-actions-sheet';
import { Mail, Plus } from 'lucide-react-native';
import { useInboxStore } from '../stores/useInboxStore';
import { useSyncStore, deriveInboxTopicHex } from '../stores/useSyncStore';
import { useAuthStore } from '../stores/useAuthStore';

export function InboxScreen() {
  const { emails, markRead } = useInboxStore();
  const { subscribe, unsubscribe } = useSyncStore();
  const { keypair } = useAuthStore();

  const inboxTopic = keypair?.publicKeyHex ? deriveInboxTopicHex(keypair.publicKeyHex) : null;

  useFocusEffect(
    useCallback(() => {
      if (!inboxTopic) return;
      subscribe(inboxTopic);
      return () => unsubscribe(inboxTopic);
    }, [inboxTopic, subscribe, unsubscribe])
  );


  const openEmail = (messageId: string) => {
    const email = emails.find((e) => e.messageId === messageId);
    if (!email) return;
    markRead(messageId);
    SheetManager.show('email-detail-sheet', { payload: email });
  };

  const renderItem = ({ item }: { item: typeof emails[number] }) => (
    <TouchableOpacity style={styles.row} onPress={() => openEmail(item.messageId)}>
      <View style={styles.rowLeft}>
        {!item.isRead && <View style={styles.unreadDot} />}
        <View style={styles.rowText}>
          <Text style={[styles.from, !item.isRead && styles.bold]}>{item.from}</Text>
          <Text style={[styles.subject, !item.isRead && styles.bold]} numberOfLines={1}>
            {item.subject}
          </Text>
          <Text style={styles.preview} numberOfLines={1}>{item.bodyText}</Text>
        </View>
      </View>
      <Text style={styles.time}>
        {new Date(item.receivedAt).toLocaleDateString()}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={emails}
        keyExtractor={(e) => e.messageId}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Mail size={48} color="#444" />
            <Text style={styles.emptyText}>No messages yet</Text>
          </View>
        }
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => SheetManager.show('compose-email-sheet')}
      >
        <Plus size={24} color="#000" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
  },
  rowLeft: { flexDirection: 'row', flex: 1, alignItems: 'flex-start', gap: 8 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#F2E58F', marginTop: 6 },
  rowText: { flex: 1 },
  from: { color: '#aaa', fontSize: 12 },
  subject: { color: '#fff', fontSize: 15, marginTop: 2 },
  preview: { color: '#666', fontSize: 13, marginTop: 2 },
  bold: { fontWeight: '700' },
  time: { color: '#555', fontSize: 11 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 120, gap: 12 },
  emptyText: { color: '#555', fontSize: 15 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#F2E58F',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});

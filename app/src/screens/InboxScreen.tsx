import React, { useEffect, useCallback } from 'react';
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
import { blake3 } from '@noble/hashes/blake3';
import { useInboxStore } from '../stores/useInboxStore';
import { useSyncStore } from '../stores/useSyncStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useDMStore } from '../stores/useDMStore';

function truncateKey(key: string): string {
  if (key.length <= 20) return key;
  return key.slice(0, 8) + '...' + key.slice(-8);
}

function deriveInboxTopicHex(pubkeyHex: string): string {
  const bytes = new Uint8Array(
    pubkeyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );
  const suffix = new TextEncoder().encode('gardens:inbox:v1');
  const input = new Uint8Array(bytes.length + suffix.length);
  input.set(bytes);
  input.set(suffix, bytes.length);
  const hash = blake3(input);
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function InboxScreen() {
  const { emails, markRead } = useInboxStore();
  const { subscribe, unsubscribe, opTick } = useSyncStore();
  const { keypair } = useAuthStore();
  const { requests, fetchThreads, acceptRequest, declineRequest } = useDMStore();
  const myKey = keypair?.publicKeyHex ?? '';

  const inboxTopic = keypair?.publicKeyHex ? deriveInboxTopicHex(keypair.publicKeyHex) : null;

  useFocusEffect(
    useCallback(() => {
      if (!inboxTopic) return;
      subscribe(inboxTopic);
      return () => unsubscribe(inboxTopic);
    }, [inboxTopic, subscribe, unsubscribe])
  );

  useEffect(() => {
    // opTick increments for new ops; inbox store is updated by useSyncStore.
  }, [opTick]);

  useEffect(() => {
    fetchThreads();
  }, []);

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
      {requests.length > 0 && (
        <View style={styles.requestsSection}>
          <Text style={styles.sectionTitle}>Message Requests</Text>
          {requests.map(req => {
            const contactKey = req.initiatorKey === myKey ? req.recipientKey : req.initiatorKey;
            return (
              <View key={req.threadId} style={styles.requestRow}>
                <Text style={styles.requestKeyText}>{truncateKey(contactKey)}</Text>
                <View style={styles.requestActions}>
                  <TouchableOpacity
                    style={[styles.reqBtn, styles.acceptBtn]}
                    onPress={() => acceptRequest(req.threadId)}
                  >
                    <Text style={styles.acceptBtnText}>Accept</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.reqBtn, styles.declineBtn]}
                    onPress={() => declineRequest(req.threadId)}
                  >
                    <Text style={styles.declineBtnText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
      )}
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
  requestsSection: { paddingTop: 12, paddingHorizontal: 16, paddingBottom: 4 },
  sectionTitle: { color: '#888', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.8 },
  requestRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  requestKeyText: { color: '#eee', fontSize: 14, fontFamily: 'monospace', flex: 1 },
  requestActions: { flexDirection: 'row', gap: 8 },
  reqBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 6, borderWidth: 1 },
  acceptBtn: { borderColor: '#4ade80', backgroundColor: 'transparent' },
  acceptBtnText: { color: '#4ade80', fontSize: 13, fontWeight: '600' },
  declineBtn: { borderColor: '#555', backgroundColor: 'transparent' },
  declineBtnText: { color: '#888', fontSize: 13 },
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

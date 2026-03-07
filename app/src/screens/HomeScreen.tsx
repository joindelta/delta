import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import type { NavigationProp } from '@react-navigation/native';
import { useOrgsStore } from '../stores/useOrgsStore';
import { useDMStore } from '../stores/useDMStore';
import { useProfileStore } from '../stores/useProfileStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useInboxStore } from '../stores/useInboxStore';
import { BlobImage } from '../components/BlobImage';

interface Props {
  navigation: NavigationProp<any>;
}

// Deterministic color from a string seed
const AVATAR_COLORS = ['#c084fc', '#f472b6', '#fb923c', '#34d399', '#60a5fa', '#a78bfa', '#f87171'];
function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

type ListItem =
  | { kind: 'dm';  threadId: string; recipientKey: string; lastMessageAt: number | null; sortTs: number }
  | { kind: 'org'; orgId: string;    name: string;          typeLabel: string;            sortTs: number };

export function HomeScreen({ navigation }: Props) {
  const { orgs, fetchMyOrgs } = useOrgsStore();
  const { threads, fetchThreads } = useDMStore();
  const { myProfile, profileCache, fetchProfile } = useProfileStore();
  const { keypair } = useAuthStore();
  const { unreadCount } = useInboxStore();
  const [loading, setLoading] = useState(true);

  const myKey = myProfile?.publicKey ?? keypair?.publicKeyHex ?? '';

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!myKey || threads.length === 0) return;
    for (const t of threads) {
      const recipientKey = t.initiatorKey === myKey ? t.recipientKey : t.initiatorKey;
      fetchProfile(recipientKey);
    }
  }, [threads, myKey, fetchProfile]);

  async function loadData() {
    setLoading(true);
    try {
      await Promise.all([fetchMyOrgs(), fetchThreads()]);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  const items: ListItem[] = [
    ...threads.map(t => {
      const recipientKey = t.initiatorKey === myKey ? t.recipientKey : t.initiatorKey;
      return {
        kind: 'dm' as const,
        threadId: t.threadId,
        recipientKey,
        lastMessageAt: t.lastMessageAt,
        sortTs: t.lastMessageAt ?? t.createdAt,
      };
    }),
    ...orgs.map(o => ({
      kind: 'org' as const,
      orgId: o.orgId,
      name: o.name,
      typeLabel: o.typeLabel,
      sortTs: o.createdAt,
    })),
  ].sort((a, b) => b.sortTs - a.sortTs);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  function renderItem({ item }: { item: ListItem }) {
    if (item.kind === 'dm') {
      const profile = profileCache[item.recipientKey];
      const displayName = profile?.username ?? item.recipientKey.slice(0, 12) + '…';
      const initials = (profile?.username ?? item.recipientKey).slice(0, 2).toUpperCase();
      const color = avatarColor(item.recipientKey);
      return (
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={() => navigation.navigate('DMChat', { threadId: item.threadId, recipientKey: item.recipientKey })}
        >
          {profile?.avatarBlobId ? (
            <BlobImage blobHash={profile.avatarBlobId} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: color }]}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          )}
          <View style={styles.rowBody}>
            <View style={styles.rowTop}>
              <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
              <Text style={styles.time}>{formatTime(item.lastMessageAt)}</Text>
            </View>
            <Text style={styles.sub} numberOfLines={1}>
              {item.lastMessageAt ? 'Direct message' : 'No messages yet'}
            </Text>
          </View>
        </TouchableOpacity>
      );
    }

    // org
    const initials = item.name.slice(0, 2).toUpperCase();
    const color = avatarColor(item.name);
    const org = orgs.find(o => o.orgId === item.orgId);
    return (
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('OrgChat', { orgId: item.orgId, orgName: item.name })}
      >
        {org?.avatarBlobId ? (
          <BlobImage blobHash={org.avatarBlobId} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, { backgroundColor: color }]}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        )}
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.time}>{formatTime(item.sortTs)}</Text>
          </View>
          <Text style={styles.sub} numberOfLines={1}>{item.typeLabel}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <FlatList
      style={styles.root}
      data={items}
      keyExtractor={item => item.kind === 'dm' ? item.threadId : item.orgId}
      renderItem={renderItem}
      ListHeaderComponent={
        <TouchableOpacity
          style={styles.inboxRow}
          activeOpacity={0.7}
          onPress={() => navigation.navigate('Inbox')}
        >
          <View style={styles.inboxLeft}>
            <Text style={styles.inboxLabel}>Inbox</Text>
            <Text style={styles.inboxSub}>Email messages</Text>
          </View>
          {unreadCount > 0 && (
            <View style={styles.inboxBadge}>
              <Text style={styles.inboxBadgeText}>{unreadCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No conversations yet</Text>
          <Text style={styles.emptySub}>Tap + to start one</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 1 },
  name: { color: '#fff', fontSize: 15, fontWeight: '600', flex: 1, marginRight: 8 },
  time: { color: '#888', fontSize: 12, flexShrink: 0 },
  sub: { color: '#888', fontSize: 13 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 120 },
  emptyText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  emptySub: { color: '#555', fontSize: 14, marginTop: 6 },

  inboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
    backgroundColor: '#0c0c0c',
  },
  inboxLeft: { flex: 1 },
  inboxLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  inboxSub: { color: '#666', fontSize: 12, marginTop: 2 },
  inboxBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#F2E58F',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  inboxBadgeText: { color: '#000', fontSize: 12, fontWeight: '700' },
});

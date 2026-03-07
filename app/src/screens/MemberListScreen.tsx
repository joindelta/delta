import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SheetManager } from 'react-native-actions-sheet';
import type { MainStackParamList } from '../navigation/RootNavigator';
import type { MemberInfo } from '../ffi/gardensCore';
import { listOrgMembers, getProfile } from '../ffi/gardensCore';
import { BlobImage } from '../components/BlobImage';

type Props = NativeStackScreenProps<MainStackParamList, 'MemberList'>;

interface MemberWithProfile extends MemberInfo {
  username?: string;
  avatarBlobId?: string | null;
  bio?: string | null;
}

export function MemberListScreen({ route, navigation }: Props) {
  const { orgId, orgName } = route.params;
  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listOrgMembers(orgId);
      
      // Load profiles for each member to get display names
      const membersWithProfiles = await Promise.all(
        list.map(async (member) => {
          try {
            const profile = await getProfile(member.publicKey);
            return {
              ...member,
              username: profile?.username,
              avatarBlobId: profile?.avatarBlobId,
              bio: profile?.bio,
            };
          } catch {
            return member;
          }
        })
      );
      
      setMembers(membersWithProfiles);
    } catch {
      // Failed to load members
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  function handleAddMember() {
    navigation.navigate('AddMember', { orgId, orgName });
  }

  function handleMemberPress(member: MemberWithProfile) {
    SheetManager.show('member-actions-sheet', {
      payload: {
        member,
        orgId,
        onAction: loadMembers,
      },
    });
  }

  function getBadgeStyle(level: string) {
    switch (level) {
      case 'Pull': return styles.badgePull;
      case 'Read': return styles.badgeRead;
      case 'Write': return styles.badgeWrite;
      case 'Manage': return styles.badgeManage;
      default: return styles.badgePull;
    }
  }

  const renderMember = ({ item }: { item: MemberWithProfile }) => {
    const displayName = item.username || item.publicKey.slice(0, 16) + '...';
    const subtitle = item.username ? item.publicKey.slice(0, 16) + '...' : `Joined ${new Date(item.joinedAt).toLocaleDateString()}`;
    const initials = (item.username || item.publicKey).slice(0, 2).toUpperCase();

    return (
      <TouchableOpacity style={styles.card} onPress={() => handleMemberPress(item)}>
        {item.avatarBlobId ? (
          <BlobImage blobHash={item.avatarBlobId} style={styles.avatar} />
        ) : (
          <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        )}
        <View style={styles.cardBody}>
          <Text style={styles.displayName}>{displayName}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          {item.bio && (
            <Text style={styles.bio} numberOfLines={1}>{item.bio}</Text>
          )}
        </View>
        <View style={[styles.badge, getBadgeStyle(item.accessLevel)]}>
          <Text style={styles.badgeText}>{item.accessLevel}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{orgName} Members</Text>
        <TouchableOpacity style={styles.addBtn} onPress={handleAddMember}>
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={members}
        keyExtractor={item => item.publicKey}
        contentContainerStyle={styles.list}
        renderItem={renderMember}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No members yet</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'space-between', 
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  addBtn: { 
    backgroundColor: '#3b82f6', 
    borderRadius: 8, 
    paddingHorizontal: 16, 
    paddingVertical: 8,
  },
  addBtnText: { color: '#fff', fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 32, paddingTop: 8 },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    marginRight: 12,
  },
  avatarPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  cardBody: { flex: 1 },
  displayName: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 2 },
  subtitle: { color: '#666', fontSize: 12, fontFamily: 'monospace' },
  bio: { color: '#888', fontSize: 12, marginTop: 4 },
  badge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  badgePull: { backgroundColor: '#374151' },
  badgeRead: { backgroundColor: '#1e40af' },
  badgeWrite: { backgroundColor: '#7c3aed' },
  badgeManage: { backgroundColor: '#dc2626' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    color: '#555',
    fontSize: 16,
  },
});

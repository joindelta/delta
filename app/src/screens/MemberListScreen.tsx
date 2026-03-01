import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MemberInfo } from '../ffi/deltaCore';
import { listOrgMembers, removeMemberFromOrg, changeMemberPermission } from '../ffi/deltaCore';

type Props = NativeStackScreenProps<any, 'MemberList'>;

const ACCESS_LEVELS = ['Pull', 'Read', 'Write', 'Manage'];

export function MemberListScreen({ route, navigation }: Props) {
  const { orgId, orgName } = route.params as { orgId: string; orgName: string };
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMembers() {
    setLoading(true);
    try {
      const list = await listOrgMembers(orgId);
      setMembers(list);
    } catch {
      Alert.alert('Error', 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }

  function handleAddMember() {
    navigation.navigate('AddMember', { orgId, orgName });
  }

  function handleMemberPress(member: MemberInfo) {
    Alert.alert(
      member.publicKey.slice(0, 16) + '...',
      'Choose an action',
      [
        { text: 'Change Permission', onPress: () => handleChangePermission(member) },
        { text: 'Remove Member', onPress: () => handleRemoveMember(member), style: 'destructive' },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  function handleChangePermission(member: MemberInfo) {
    Alert.alert(
      'Change Permission',
      `Current: ${member.accessLevel}`,
      ACCESS_LEVELS.map(level => ({
        text: level,
        onPress: async () => {
          try {
            await changeMemberPermission(orgId, member.publicKey, level);
            await loadMembers();
            Alert.alert('Success', `Permission changed to ${level}`);
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Failed to change permission');
          }
        },
      })).concat({ text: 'Cancel', style: 'cancel' }),
    );
  }

  async function handleRemoveMember(member: MemberInfo) {
    Alert.alert(
      'Remove Member',
      'Are you sure? This action cannot be undone.',
      [
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeMemberFromOrg(orgId, member.publicKey);
              await loadMembers();
              Alert.alert('Success', 'Member removed');
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to remove member');
            }
          },
        },
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
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => handleMemberPress(item)}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{item.publicKey.slice(0, 2).toUpperCase()}</Text>
            </View>
            <View style={styles.cardBody}>
              <Text style={styles.pubKey}>{item.publicKey.slice(0, 16)}...</Text>
              <Text style={styles.joinedAt}>
                Joined {new Date(item.joinedAt).toLocaleDateString()}
              </Text>
            </View>
            <View style={[styles.badge, styles[`badge${item.accessLevel}` as keyof typeof styles]]}>
              <Text style={styles.badgeText}>{item.accessLevel}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  addBtn: { backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: '#fff', fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
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
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  cardBody: { flex: 1 },
  pubKey: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 2 },
  joinedAt: { color: '#888', fontSize: 12 },
  badge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  badgePull: { backgroundColor: '#374151' },
  badgeRead: { backgroundColor: '#1e40af' },
  badgeWrite: { backgroundColor: '#7c3aed' },
  badgeManage: { backgroundColor: '#dc2626' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});

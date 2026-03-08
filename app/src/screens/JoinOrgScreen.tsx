import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/RootNavigator';
import { verifyInviteToken, claimInviteToken } from '../ffi/gardensCore';
import { broadcastOp } from '../stores/useSyncStore';
import { useOrgsStore } from '../stores/useOrgsStore';

type Props = NativeStackScreenProps<MainStackParamList, 'JoinOrg'>;

export function JoinOrgScreen({ route, navigation }: Props) {
  const { token } = route.params;
  const { fetchMyOrgs } = useOrgsStore();

  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<{
    orgId: string;
    inviterKey: string;
    accessLevel: string;
    expiryTimestamp: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const result = verifyInviteToken(token, Date.now());
      setInfo(result);
    } catch (err: any) {
      setError(err.message || 'Invalid or expired invite');
    }
  }, [token]);

  async function handleJoin() {
    if (!info) return;
    setLoading(true);
    try {
      const result = await claimInviteToken(token);
      // Broadcast the membership op to the org topic so other members see it
      if (result.opBytes?.length) {
        broadcastOp(result.id, result.opBytes);
      }
      await fetchMyOrgs();
      Alert.alert(
        'Joined!',
        `You've joined the organization with ${info.accessLevel} access.`,
        [{ text: 'OK', onPress: () => navigation.reset({ index: 0, routes: [{ name: 'Home' }] }) }],
      );
    } catch (err: any) {
      Alert.alert('Failed to join', err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return (
      <View style={s.root}>
        <View style={s.center}>
          <Text style={s.errorTitle}>Invalid Invite</Text>
          <Text style={s.errorDesc}>{error}</Text>
          <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()}>
            <Text style={s.backBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!info) {
    return (
      <View style={s.root}>
        <View style={s.center}>
          <ActivityIndicator color="#fff" />
        </View>
      </View>
    );
  }

  const expires = new Date(info.expiryTimestamp).toLocaleString();

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <View style={s.card}>
        <Text style={s.cardLabel}>Organization Invite</Text>

        <View style={s.row}>
          <Text style={s.rowLabel}>Org ID</Text>
          <Text style={s.rowValue} numberOfLines={1}>{info.orgId.slice(0, 20)}…</Text>
        </View>
        <View style={s.row}>
          <Text style={s.rowLabel}>Access Level</Text>
          <Text style={[s.rowValue, s.accessBadge]}>{info.accessLevel}</Text>
        </View>
        <View style={s.row}>
          <Text style={s.rowLabel}>Invited by</Text>
          <Text style={s.rowValue} numberOfLines={1}>{info.inviterKey.slice(0, 16)}…</Text>
        </View>
        <View style={s.row}>
          <Text style={s.rowLabel}>Expires</Text>
          <Text style={s.rowValue}>{expires}</Text>
        </View>
      </View>

      <TouchableOpacity
        style={[s.joinBtn, loading && s.joinBtnDisabled]}
        onPress={handleJoin}
        disabled={loading}
      >
        {loading
          ? <ActivityIndicator color="#000" />
          : <Text style={s.joinBtnText}>Join Organization</Text>
        }
      </TouchableOpacity>

      <TouchableOpacity style={s.cancelBtn} onPress={() => navigation.goBack()}>
        <Text style={s.cancelBtnText}>Cancel</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 24, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },

  card: {
    backgroundColor: '#111',
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
    gap: 16,
  },
  cardLabel: { color: '#888', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { color: '#555', fontSize: 13 },
  rowValue: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1, marginLeft: 16, textAlign: 'right' },
  accessBadge: { color: '#F2E58F' },

  joinBtn: {
    backgroundColor: '#F2E58F',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  joinBtnDisabled: { opacity: 0.5 },
  joinBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },

  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: '#555', fontSize: 15 },

  errorTitle: { color: '#ef4444', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  errorDesc: { color: '#888', fontSize: 14, textAlign: 'center', marginBottom: 24 },
  backBtn: { backgroundColor: '#1a1a1a', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
  backBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});

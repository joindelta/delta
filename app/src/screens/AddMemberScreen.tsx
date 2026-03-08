import React, { useState, useEffect } from 'react';
import { Smartphone, Link, Copy, Share2 } from 'lucide-react-native';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Share,
  Clipboard,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/RootNavigator';
import NfcManager, { NfcTech, Ndef } from 'react-native-nfc-manager';
import { verifyInviteToken, addMemberDirect, generateInviteToken } from '../ffi/gardensCore';
import { broadcastOp, deriveInboxTopicHex } from '../stores/useSyncStore';
import { sendMemberAddedPushNotification } from '../services/pushNotifications';
import { useOrgsStore } from '../stores/useOrgsStore';

type Props = NativeStackScreenProps<MainStackParamList, 'AddMember'>;

const ACCESS_LEVELS = ['pull', 'read', 'write', 'manage'];
const ACCESS_LEVEL_LABELS: Record<string, string> = { pull: 'Pull', read: 'Read', write: 'Write', manage: 'Manage' };
const EXPIRY_OPTIONS = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

export function AddMemberScreen({ route, navigation }: Props) {
  const { orgId, orgName } = route.params;
  const { fetchMyOrgs } = useOrgsStore();
  const [nfcSupported, setNfcSupported] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState('read');
  const [expiryHours, setExpiryHours] = useState(24);
  const [manualKey, setManualKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    checkNfcSupport();
    return () => {
      NfcManager.cancelTechnologyRequest().catch(() => {});
    };
  }, []);

  // Reset generated link when access level or expiry changes
  useEffect(() => { setGeneratedLink(null); setCopied(false); }, [selectedLevel, expiryHours]);

  async function checkNfcSupport() {
    try {
      const supported = await NfcManager.isSupported();
      setNfcSupported(supported);
      if (supported) await NfcManager.start();
    } catch {
      setNfcSupported(false);
    }
  }

  async function handleNfcScan() {
    if (!nfcSupported) {
      Alert.alert('NFC Not Supported', 'This device does not support NFC');
      return;
    }
    setScanning(true);
    try {
      await NfcManager.requestTechnology(NfcTech.Ndef);
      const tag = await NfcManager.getTag();
      if (tag?.ndefMessage && tag.ndefMessage.length > 0) {
        const record = tag.ndefMessage[0];
        const payloadBytes = record.payload;
        if (payloadBytes) {
          const payload = Ndef.text.decodePayload(new Uint8Array(payloadBytes));
          const token = payload.startsWith('gardens://invite/')
            ? payload.slice('gardens://invite/'.length)
            : payload.startsWith('gardens-invite:')
            ? payload.slice('gardens-invite:'.length)
            : null;
          if (token) {
            await processInviteToken(token);
          } else {
            Alert.alert('Invalid Tag', 'This NFC tag does not contain a Gardens invite');
          }
        }
      }
    } catch (err: any) {
      if (err.message !== 'Not even registered') {
        Alert.alert('NFC Error', err.message || 'Failed to read NFC tag');
      }
    } finally {
      setScanning(false);
      NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }

  async function processInviteToken(token: string) {
    try {
      const info = verifyInviteToken(token, Date.now());
      if (info.orgId !== orgId) {
        Alert.alert('Wrong Organization', 'This invite is for a different organization');
        return;
      }
      Alert.alert(
        'Add Member',
        `Access Level: ${info.accessLevel}\nInviter: ${info.inviterKey.slice(0, 16)}...`,
        [
          {
            text: 'Add',
            onPress: async () => {
              try {
                await addMemberDirect(orgId, info.inviterKey, info.accessLevel);
                Alert.alert('Success', 'Member added successfully');
                navigation.goBack();
              } catch (err: any) {
                Alert.alert('Error', err.message || 'Failed to add member');
              }
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    } catch (err: any) {
      Alert.alert('Invalid Token', err.message || 'Token verification failed');
    }
  }

  function handleGenerateLink() {
    try {
      const expiry = Date.now() + expiryHours * 60 * 60 * 1000;
      const token = generateInviteToken(orgId, selectedLevel, expiry);
      setGeneratedLink(`gardens://invite/${token}`);
      setCopied(false);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate invite');
    }
  }

  function handleCopy() {
    if (!generatedLink) return;
    Clipboard.setString(generatedLink);
    setCopied(true);
  }

  async function handleShare() {
    if (!generatedLink) return;
    try {
      await Share.share({
        message: `Join ${orgName} on Gardens!\n\n${generatedLink}`,
        url: generatedLink,
        title: `Join ${orgName}`,
      });
    } catch {
      // cancelled
    }
  }

  async function handleManualAdd() {
    const key = manualKey.trim();
    if (!key) {
      Alert.alert('Missing Key', 'Please enter a public key');
      return;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      Alert.alert('Invalid Key', 'Public key must be 64 hex characters');
      return;
    }
    setAdding(true);
    try {
      const result = await addMemberDirect(orgId, key, selectedLevel);
      // Broadcast op to org topic and new member's inbox so their device syncs it
      if (result.opBytes?.length) {
        broadcastOp(orgId, result.opBytes);
        broadcastOp(deriveInboxTopicHex(key), result.opBytes);
      }
      // Push notification so they can accept the peering
      sendMemberAddedPushNotification({ recipientKey: key, orgName, orgId, accessLevel: selectedLevel }).catch(() => {});
      await fetchMyOrgs();
      Alert.alert('Success', 'Member added — they will receive a notification to accept.');
      setManualKey('');
      navigation.goBack();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to add member');
    } finally {
      setAdding(false);
    }
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add Member</Text>
      <Text style={styles.subtitle}>Choose a method to add a new member</Text>

      {/* Access Level + Expiry */}
      <View style={styles.row2col}>
        <View style={styles.col}>
          <Text style={styles.levelLabel}>Access Level</Text>
          <View style={styles.levelButtons}>
            {ACCESS_LEVELS.map(level => (
              <TouchableOpacity
                key={level}
                style={[styles.levelBtn, selectedLevel === level && styles.levelBtnActive]}
                onPress={() => setSelectedLevel(level)}
              >
                <Text style={[styles.levelBtnText, selectedLevel === level && styles.levelBtnTextActive]}>
                  {ACCESS_LEVEL_LABELS[level]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <View style={styles.col}>
          <Text style={styles.levelLabel}>Expires</Text>
          <View style={styles.levelButtons}>
            {EXPIRY_OPTIONS.map(o => (
              <TouchableOpacity
                key={o.hours}
                style={[styles.levelBtn, expiryHours === o.hours && styles.levelBtnActive]}
                onPress={() => setExpiryHours(o.hours)}
              >
                <Text style={[styles.levelBtnText, expiryHours === o.hours && styles.levelBtnTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* Invite Link */}
      <View style={styles.methodCard}>
        <Link size={28} color="#3b82f6" style={styles.methodIconLucide} />
        <Text style={styles.methodTitle}>Invite Link</Text>
        <Text style={styles.methodDesc}>Generate a link to share with someone</Text>
        {!generatedLink ? (
          <TouchableOpacity style={styles.addBtn} onPress={handleGenerateLink}>
            <Text style={styles.addBtnText}>Generate Link</Text>
          </TouchableOpacity>
        ) : (
          <>
            <Text style={styles.linkText} numberOfLines={2} selectable>{generatedLink}</Text>
            <View style={styles.linkActions}>
              <TouchableOpacity style={styles.linkBtn} onPress={handleCopy}>
                <Copy size={14} color={copied ? '#4ade80' : '#fff'} />
                <Text style={[styles.linkBtnText, copied && { color: '#4ade80' }]}>
                  {copied ? 'Copied!' : 'Copy'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkBtn} onPress={handleShare}>
                <Share2 size={14} color="#fff" />
                <Text style={styles.linkBtnText}>Share</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      {/* NFC */}
      <TouchableOpacity
        style={[styles.methodCard, !nfcSupported && styles.methodCardDisabled]}
        onPress={handleNfcScan}
        disabled={!nfcSupported || scanning}
      >
        <Smartphone size={28} color="#3b82f6" style={styles.methodIconLucide} />
        <Text style={styles.methodTitle}>NFC Tap</Text>
        <Text style={styles.methodDesc}>
          {scanning ? 'Hold device near NFC tag...' : 'Tap to scan an NFC invite tag'}
        </Text>
        {!nfcSupported && <Text style={styles.notSupported}>Not supported on this device</Text>}
      </TouchableOpacity>

      {/* Manual key */}
      <View style={styles.manualCard}>
        <Text style={styles.methodIconEmoji}>✍️</Text>
        <Text style={styles.methodTitle}>Manual Entry</Text>
        <Text style={styles.methodDesc}>Paste a member's public key directly</Text>
        <TextInput
          style={styles.keyInput}
          value={manualKey}
          onChangeText={setManualKey}
          placeholder="64-char hex public key"
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          multiline={false}
        />
        <TouchableOpacity
          style={[styles.addBtn, (adding || !manualKey.trim()) && styles.addBtnDisabled]}
          onPress={handleManualAdd}
          disabled={adding || !manualKey.trim()}
        >
          {adding
            ? <ActivityIndicator size="small" color="#000" />
            : <Text style={styles.addBtnText}>Add Member</Text>}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 16, paddingBottom: 32 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 4 },
  subtitle: { color: '#888', fontSize: 14, marginBottom: 24 },

  row2col: { flexDirection: 'row', gap: 16, marginBottom: 24 },
  col: { flex: 1 },
  levelLabel: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  levelButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  levelBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  levelBtnActive: { borderColor: '#3b82f6', backgroundColor: '#1e3a8a' },
  levelBtnText: { color: '#888', fontSize: 12, fontWeight: '600' },
  levelBtnTextActive: { color: '#fff' },

  methodCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 20,
    marginBottom: 12,
    alignItems: 'center',
    gap: 10,
  },
  methodCardDisabled: { opacity: 0.5 },
  methodIconLucide: { marginBottom: 2 },
  methodTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  methodDesc: { color: '#888', fontSize: 13, textAlign: 'center' },
  notSupported: { color: '#dc2626', fontSize: 12 },

  linkText: {
    color: '#aaa',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  linkActions: { flexDirection: 'row', gap: 10 },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#374151',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  linkBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  manualCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 20,
    marginBottom: 12,
    alignItems: 'center',
    gap: 12,
  },
  methodIconEmoji: { fontSize: 32, marginBottom: 2 },
  keyInput: {
    backgroundColor: '#111',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    width: '100%',
    borderWidth: 1,
    borderColor: '#333',
    fontFamily: 'monospace',
  },
  addBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  addBtnDisabled: { opacity: 0.4 },
  addBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

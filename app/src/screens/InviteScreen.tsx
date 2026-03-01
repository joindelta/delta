import React, { useState, useEffect } from 'react';
import { Share2, Smartphone } from 'lucide-react-native';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Share,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-svg';
import NfcManager, { NfcTech, Ndef } from 'react-native-nfc-manager';
import { generateInviteToken } from '../ffi/deltaCore';

type Props = NativeStackScreenProps<any, 'Invite'>;

const ACCESS_LEVELS = ['Pull', 'Read', 'Write', 'Manage'];
const EXPIRY_OPTIONS = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
];

export function InviteScreen({ route }: Props) {
  const { orgId, orgName } = route.params as { orgId: string; orgName: string };
  const [accessLevel, setAccessLevel] = useState('Read');
  const [expiryHours, setExpiryHours] = useState(24);
  const [token, setToken] = useState<string | null>(null);
  const [nfcSupported, setNfcSupported] = useState(false);

  useEffect(() => {
    checkNfcSupport();
  }, []);

  async function checkNfcSupport() {
    try {
      const supported = await NfcManager.isSupported();
      setNfcSupported(supported);
      if (supported) {
        await NfcManager.start();
      }
    } catch {
      setNfcSupported(false);
    }
  }

  function handleGenerate() {
    try {
      const expiryTimestamp = Date.now() + expiryHours * 60 * 60 * 1000;
      const newToken = generateInviteToken(orgId, accessLevel, expiryTimestamp);
      setToken(newToken);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate invite token');
    }
  }

  async function handleShare() {
    if (!token) return;
    try {
      await Share.share({
        message: `Join ${orgName} on Delta!\n\nInvite code: ${token}\n\nAccess level: ${accessLevel}\nExpires in ${expiryHours} hours`,
        title: `Join ${orgName}`,
      });
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to share');
    }
  }

  async function handleWriteNfc() {
    if (!token || !nfcSupported) return;

    try {
      await NfcManager.requestTechnology(NfcTech.Ndef);
      
      const payload = `delta-invite:${token}`;
      const bytes = Ndef.encodeMessage([Ndef.textRecord(payload)]);
      
      if (bytes) {
        await NfcManager.ndefHandler.writeNdefMessage(bytes);
        Alert.alert('Success', 'Invite written to NFC tag');
      }
    } catch (err: any) {
      Alert.alert('NFC Error', err.message || 'Failed to write to NFC tag');
    } finally {
      NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Generate Invite</Text>
      <Text style={styles.subtitle}>Create an invite link for {orgName}</Text>

      <View style={styles.section}>
        <Text style={styles.label}>Access Level</Text>
        <View style={styles.buttonRow}>
          {ACCESS_LEVELS.map(level => (
            <TouchableOpacity
              key={level}
              style={[styles.optionBtn, accessLevel === level && styles.optionBtnActive]}
              onPress={() => setAccessLevel(level)}
            >
              <Text style={[styles.optionText, accessLevel === level && styles.optionTextActive]}>
                {level}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Expires In</Text>
        <View style={styles.buttonRow}>
          {EXPIRY_OPTIONS.map(option => (
            <TouchableOpacity
              key={option.hours}
              style={[styles.optionBtn, expiryHours === option.hours && styles.optionBtnActive]}
              onPress={() => setExpiryHours(option.hours)}
            >
              <Text style={[styles.optionText, expiryHours === option.hours && styles.optionTextActive]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <TouchableOpacity style={styles.generateBtn} onPress={handleGenerate}>
        <Text style={styles.generateBtnText}>Generate Invite</Text>
      </TouchableOpacity>

      {token && (
        <View style={styles.tokenCard}>
          <View style={styles.qrContainer}>
            <QRCode value={token} size={200} backgroundColor="#fff" />
          </View>

          <Text style={styles.tokenLabel}>Invite Token</Text>
          <Text style={styles.tokenText} numberOfLines={3}>
            {token}
          </Text>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionBtn} onPress={handleShare}>
              <Share2 size={16} color="#fff" />
              <Text style={styles.actionBtnText}>Share</Text>
            </TouchableOpacity>

            {nfcSupported && (
              <TouchableOpacity style={styles.actionBtn} onPress={handleWriteNfc}>
                <Smartphone size={16} color="#fff" />
                <Text style={styles.actionBtnText}>Write NFC</Text>
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.expiryNote}>
            Expires: {new Date(Date.now() + expiryHours * 60 * 60 * 1000).toLocaleString()}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 16, paddingBottom: 32 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 4 },
  subtitle: { color: '#888', fontSize: 14, marginBottom: 24 },
  section: { marginBottom: 24 },
  label: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionBtnActive: { borderColor: '#3b82f6', backgroundColor: '#1e3a8a' },
  optionText: { color: '#888', fontSize: 13, fontWeight: '600' },
  optionTextActive: { color: '#fff' },
  generateBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 24,
  },
  generateBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  tokenCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  qrContainer: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  tokenLabel: { color: '#888', fontSize: 12, marginBottom: 8 },
  tokenText: {
    color: '#fff',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 20,
  },
  actions: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  actionBtn: {
    backgroundColor: '#374151',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  expiryNote: { color: '#888', fontSize: 12, textAlign: 'center' },
});

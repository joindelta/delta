import React, { useState, useEffect } from 'react';
import { Smartphone } from 'lucide-react-native';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import NfcManager, { NfcTech, Ndef } from 'react-native-nfc-manager';
import { verifyInviteToken } from '../ffi/deltaCore';

type Props = NativeStackScreenProps<any, 'AddMember'>;

const ACCESS_LEVELS = ['Pull', 'Read', 'Write', 'Manage'];

export function AddMemberScreen({ route, navigation }: Props) {
  const { orgId } = route.params as { orgId: string };
  const [nfcSupported, setNfcSupported] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState('Read');

  useEffect(() => {
    checkNfcSupport();
    return () => {
      NfcManager.cancelTechnologyRequest().catch(() => {});
    };
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
          
          // Payload format: "delta-invite:<base64-token>"
          if (payload.startsWith('delta-invite:')) {
            const token = payload.replace('delta-invite:', '');
            await processInviteToken(token);
          } else {
            Alert.alert('Invalid Tag', 'This NFC tag does not contain a Delta invite');
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
                // In a real implementation, you'd extract the member's public key from the token
                // For now, this is a placeholder
                Alert.alert('Success', 'Member added (placeholder)');
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

  function handleQrScan() {
    Alert.alert('Coming Soon', 'QR code scanning will be available soon');
  }

  function handleManualAdd() {
    Alert.alert('Coming Soon', 'Manual member addition will be available soon');
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Add Member</Text>
      <Text style={styles.subtitle}>Choose a method to add a new member</Text>

      <View style={styles.levelPicker}>
        <Text style={styles.levelLabel}>Default Access Level:</Text>
        <View style={styles.levelButtons}>
          {ACCESS_LEVELS.map(level => (
            <TouchableOpacity
              key={level}
              style={[styles.levelBtn, selectedLevel === level && styles.levelBtnActive]}
              onPress={() => setSelectedLevel(level)}
            >
              <Text style={[styles.levelBtnText, selectedLevel === level && styles.levelBtnTextActive]}>
                {level}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <TouchableOpacity
        style={[styles.methodCard, !nfcSupported && styles.methodCardDisabled]}
        onPress={handleNfcScan}
        disabled={!nfcSupported || scanning}
      >
        <Smartphone size={28} color="#3b82f6" style={styles.methodIcon} />
        <Text style={styles.methodTitle}>NFC Tap</Text>
        <Text style={styles.methodDesc}>
          {scanning ? 'Hold device near NFC tag...' : 'Tap to scan an NFC invite tag'}
        </Text>
        {!nfcSupported && <Text style={styles.notSupported}>Not supported on this device</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={styles.methodCard} onPress={handleQrScan}>
        <Text style={styles.methodIcon}>📷</Text>
        <Text style={styles.methodTitle}>QR Code</Text>
        <Text style={styles.methodDesc}>Scan a QR code invite</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.methodCard} onPress={handleManualAdd}>
        <Text style={styles.methodIcon}>✍️</Text>
        <Text style={styles.methodTitle}>Manual Entry</Text>
        <Text style={styles.methodDesc}>Enter a public key directly</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 4 },
  subtitle: { color: '#888', fontSize: 14, marginBottom: 24 },
  levelPicker: { marginBottom: 24 },
  levelLabel: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  levelButtons: { flexDirection: 'row', gap: 8 },
  levelBtn: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  levelBtnActive: { borderColor: '#3b82f6', backgroundColor: '#1e3a8a' },
  levelBtnText: { color: '#888', fontSize: 13, fontWeight: '600' },
  levelBtnTextActive: { color: '#fff' },
  methodCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 20,
    marginBottom: 12,
    alignItems: 'center',
  },
  methodCardDisabled: { opacity: 0.5 },
  methodIcon: { fontSize: 48, marginBottom: 12 },
  methodTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 4 },
  methodDesc: { color: '#888', fontSize: 13, textAlign: 'center' },
  notSupported: { color: '#dc2626', fontSize: 12, marginTop: 8 },
});

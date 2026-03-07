import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Clipboard,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { X, Copy, Eye, EyeOff, Shield } from 'lucide-react-native';
import * as Keychain from 'react-native-keychain';

const MNEMONIC_SERVICE = 'gardens.mnemonic';

export function BackupSeedSheet(props: SheetProps<'backup-seed-sheet'>) {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadMnemonic();
  }, []);

  const loadMnemonic = async () => {
    setLoading(true);
    try {
      const result = await Keychain.getGenericPassword({ service: MNEMONIC_SERVICE });
      if (result) {
        setMnemonic(result.password);
      }
    } catch (err) {
      console.error('Failed to load mnemonic:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!mnemonic) return;
    try {
      Clipboard.setString(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      Alert.alert('Error', 'Failed to copy to clipboard');
    }
  };

  const toggleReveal = () => {
    setRevealed(!revealed);
  };

  function close() {
    SheetManager.hide('backup-seed-sheet');
  }

  const renderMnemonic = () => {
    if (!mnemonic) return null;
    const words = mnemonic.split(' ');
    return (
      <View style={s.wordsGrid}>
        {words.map((word, index) => (
          <View key={index} style={s.wordBox}>
            <Text style={s.wordNumber}>{index + 1}</Text>
            <Text style={s.wordText}>{revealed ? word : '••••'}</Text>
          </View>
        ))}
      </View>
    );
  };

  return (
    <ActionSheet
      id={props.sheetId}
      gestureEnabled
      containerStyle={s.container}
      indicatorStyle={s.handle}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={close} style={s.headerBtn}>
          <X size={20} color="#888" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Backup Seed Phrase</Text>
        <View style={s.headerSpacer} />
      </View>

      <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : !mnemonic ? (
          <View style={s.errorState}>
            <Shield size={48} color="#ef4444" />
            <Text style={s.errorText}>Seed phrase not found</Text>
            <Text style={s.errorSubtext}>
              Your seed phrase may have been lost. Please ensure you have a backup.
            </Text>
          </View>
        ) : (
          <>
            {/* Warning */}
            <View style={s.warningBox}>
              <Shield size={24} color="#f59e0b" />
              <Text style={s.warningText}>
                Never share your seed phrase with anyone. Anyone with access to it can control your account.
              </Text>
            </View>

            {/* Reveal toggle */}
            <TouchableOpacity style={s.revealBtn} onPress={toggleReveal}>
              {revealed ? (
                <>
                  <EyeOff size={18} color="#fff" />
                  <Text style={s.revealBtnText}>Hide Seed Phrase</Text>
                </>
              ) : (
                <>
                  <Eye size={18} color="#fff" />
                  <Text style={s.revealBtnText}>Reveal Seed Phrase</Text>
                </>
              )}
            </TouchableOpacity>

            {/* Mnemonic words */}
            <View style={s.mnemonicSection}>
              {renderMnemonic()}
            </View>

            {/* Copy button */}
            <TouchableOpacity 
              style={[s.copyBtn, copied && s.copyBtnSuccess]} 
              onPress={handleCopy}
            >
              <Copy size={18} color={copied ? '#F2E58F' : '#fff'} />
              <Text style={[s.copyBtnText, copied && s.copyBtnTextSuccess]}>
                {copied ? 'Copied!' : 'Copy to Clipboard'}
              </Text>
            </TouchableOpacity>

            {/* Security tips */}
            <View style={s.tipsSection}>
              <Text style={s.tipsTitle}>Security Tips</Text>
              <View style={s.tipItem}>
                <Text style={s.tipBullet}>•</Text>
                <Text style={s.tipText}>Write it down on paper and store in a safe place</Text>
              </View>
              <View style={s.tipItem}>
                <Text style={s.tipBullet}>•</Text>
                <Text style={s.tipText}>Never store it in cloud services or screenshots</Text>
              </View>
              <View style={s.tipItem}>
                <Text style={s.tipBullet}>•</Text>
                <Text style={s.tipText}>Don't share it with anyone, including support</Text>
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </ActionSheet>
  );
}

const s = StyleSheet.create({
  container: { 
    backgroundColor: '#111', 
    paddingHorizontal: 20, 
    paddingBottom: 40,
    minHeight: 500,
  },
  handle: { backgroundColor: '#333' },
  
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  headerBtn: { padding: 4 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 28 },
  
  content: { marginTop: 16 },
  center: { paddingVertical: 40, alignItems: 'center' },
  
  errorState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  errorSubtext: {
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 20,
  },
  
  warningBox: {
    flexDirection: 'row',
    backgroundColor: '#451a03',
    borderRadius: 12,
    padding: 16,
    gap: 12,
    marginBottom: 20,
  },
  warningText: {
    flex: 1,
    color: '#fbbf24',
    fontSize: 14,
    lineHeight: 20,
  },
  
  revealBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#1a1a1a',
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 20,
  },
  revealBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  
  mnemonicSection: {
    backgroundColor: '#0a0a0a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  wordsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  wordBox: {
    width: '30%',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  wordNumber: {
    color: '#555',
    fontSize: 11,
    width: 20,
  },
  wordText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#333',
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 24,
  },
  copyBtnSuccess: {
    backgroundColor: '#052e16',
  },
  copyBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  copyBtnTextSuccess: {
    color: '#F2E58F',
  },
  
  tipsSection: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
  },
  tipsTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  tipItem: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  tipBullet: {
    color: '#F2E58F',
    fontSize: 14,
  },
  tipText: {
    color: '#888',
    fontSize: 13,
    flex: 1,
  },
});

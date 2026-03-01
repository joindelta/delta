/**
 * SeedRecoveryScreen
 *
 * Flow:
 * 1. User enters all 24 BIP-39 words (one TextInput per word)
 * 2. importFromMnemonic() → derives keypair via Rust UniFFI
 * 3. Persists to Keychain with biometric enrolment
 * 4. Navigation to Main handled by RootNavigator reacting to isUnlocked
 */

import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  type TextInput as RNTextInput,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../navigation/RootNavigator';
import { useAuthStore } from '../stores/useAuthStore';

type Props = NativeStackScreenProps<AuthStackParamList, 'SeedRecovery'>;

const WORD_COUNT = 24;

export function SeedRecoveryScreen(_props: Props) {
  const importAccount = useAuthStore(s => s.importAccount);

  const [words, setWords]   = useState<string[]>(Array(WORD_COUNT).fill(''));
  const [loading, setLoading] = useState(false);

  // Refs so we can jump focus word → word
  const inputRefs = useRef<(RNTextInput | null)[]>(Array(WORD_COUNT).fill(null));

  function updateWord(index: number, value: string) {
    // Split on space/newline so a paste of the full phrase auto-fills all inputs.
    const pasted = value.trim().split(/\s+/);
    if (pasted.length > 1) {
      const next = [...words];
      pasted.forEach((w, i) => {
        if (index + i < WORD_COUNT) next[index + i] = w.toLowerCase();
      });
      setWords(next);
      const nextFocus = Math.min(index + pasted.length, WORD_COUNT - 1);
      inputRefs.current[nextFocus]?.focus();
    } else {
      const next = [...words];
      next[index] = value.toLowerCase();
      setWords(next);
    }
  }

  async function handleRestore() {
    const filled = words.filter(w => w.trim().length > 0);
    if (filled.length !== WORD_COUNT) {
      Alert.alert('Incomplete seed', `Please enter all ${WORD_COUNT} words.`);
      return;
    }

    setLoading(true);
    try {
      await importAccount(words.map(w => w.trim()));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Invalid seed phrase', message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.heading}>Restore from Seed</Text>
        <Text style={styles.sub}>
          Enter your 24-word recovery phrase in order. You can also paste the
          full phrase into the first box.
        </Text>

        <View style={styles.grid}>
          {words.map((word, i) => (
            <View key={i} style={styles.wordCell}>
              <Text style={styles.wordIndex}>{i + 1}</Text>
              <TextInput
                ref={el => { inputRefs.current[i] = el; }}
                style={styles.wordInput}
                value={word}
                onChangeText={v => updateWord(i, v)}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType={i < WORD_COUNT - 1 ? 'next' : 'done'}
                onSubmitEditing={() => {
                  if (i < WORD_COUNT - 1) inputRefs.current[i + 1]?.focus();
                }}
                placeholderTextColor="#444"
                placeholder={`word ${i + 1}`}
              />
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleRestore}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#0a0a0a" />
            : <Text style={styles.btnText}>Restore &amp; Enroll Biometric</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { padding: 24, paddingBottom: 48 },
  heading: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 8 },
  sub: { fontSize: 14, color: '#888', marginBottom: 28, lineHeight: 20 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  wordCell: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '47%',
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  wordIndex: {
    width: 24,
    fontSize: 12,
    color: '#555',
    fontVariant: ['tabular-nums'],
  },
  wordInput: {
    flex: 1,
    fontSize: 15,
    color: '#fff',
    padding: 0,
  },
  btn: {
    marginTop: 32,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#0a0a0a', fontSize: 16, fontWeight: '700' },
});

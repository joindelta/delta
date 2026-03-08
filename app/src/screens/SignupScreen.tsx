/**
 * SignupScreen
 *
 * Flow:
 * 1. Generate keypair (calls Rust via UniFFI)
 * 2. Enroll biometric — sets the key in iOS Keychain / Android Keystore
 * 3. Collect profile fields: username, avatar placeholder, bio, available_for
 * 4. Navigate to Main on success
 */

import React, { useState, useMemo } from 'react';
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
  Image,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../navigation/RootNavigator';
import { useAuthStore } from '../stores/useAuthStore';
import { useProfileStore } from '../stores/useProfileStore';
import { ALL_INTERESTS } from '../sheets/InterestsSheet';
import { publishProfileMeta } from '../sheets/LocationPickerSheet';

type Props = NativeStackScreenProps<AuthStackParamList, 'Signup'>;

const MAX_INTERESTS = 20;

export function SignupScreen({ navigation: _navigation }: Props) {
  const createAccount = useAuthStore(s => s.createAccount);
  const { setProfilePicUri, setLocalUsername, createOrUpdateProfile } = useProfileStore();

  const [username, setUsername]         = useState('');
  const [bio, setBio]                   = useState('');
  const [availableFor, setAvailableFor] = useState<string[]>([]);
  const [interestQuery, setInterestQuery] = useState('');
  const [profilePicUri, setLocalPicUri] = useState<string | null>(null);
  const [loading, setLoading]           = useState(false);

  const interestSuggestions = useMemo(() => {
    const q = interestQuery.trim().toLowerCase();
    const list = q
      ? ALL_INTERESTS.filter(i => i.toLowerCase().includes(q))
      : ALL_INTERESTS;
    return list.filter(i => !availableFor.includes(i)).slice(0, 30);
  }, [interestQuery, availableFor]);

  const showCustomAdd = interestQuery.trim().length > 0 &&
    !availableFor.some(t => t.toLowerCase() === interestQuery.trim().toLowerCase());

  function toggleInterest(option: string) {
    const canonical = ALL_INTERESTS.find(i => i.toLowerCase() === option.toLowerCase()) ?? option;
    setAvailableFor(prev => {
      if (prev.some(o => o.toLowerCase() === option.toLowerCase())) return prev.filter(o => o.toLowerCase() !== option.toLowerCase());
      if (prev.length >= MAX_INTERESTS) return prev;
      return [...prev, canonical];
    });
    setInterestQuery('');
  }

  async function handlePickPhoto() {
    const result = await launchImageLibrary({ mediaType: 'photo', quality: 0.8, selectionLimit: 1 });
    if (result.assets?.[0]?.uri) {
      setLocalPicUri(result.assets[0].uri);
    }
  }

  async function handleCreate() {
    if (!username.trim()) {
      Alert.alert('Username required', 'Please enter a username to continue.');
      return;
    }

    setLoading(true);
    try {
      const keypair = await createAccount();
      // Persist username locally (reliable fallback) and to the network profile.
      await setLocalUsername(username.trim());
      await createOrUpdateProfile(username.trim(), bio.trim() || null, availableFor);
      if (profilePicUri) {
        await setProfilePicUri(profilePicUri);
      }
      if (availableFor.length > 0 && keypair?.publicKeyHex) {
        publishProfileMeta(keypair.publicKeyHex, { interests: availableFor });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Account creation failed', message);
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
        <Text style={styles.heading}>Create Account</Text>
        <Text style={styles.sub}>Your identity lives on this device, protected by biometrics.</Text>

        {/* Profile pic picker */}
        <TouchableOpacity style={styles.avatarWrap} onPress={handlePickPhoto}>
          {profilePicUri ? (
            <Image source={{ uri: profilePicUri }} style={styles.avatarImg} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarPlaceholderText}>+</Text>
            </View>
          )}
          <Text style={styles.avatarHint}>
            {profilePicUri ? 'Tap to change' : 'Add photo (optional)'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.label}>Username</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. alice"
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
        />

        <Text style={styles.label}>Bio (optional)</Text>
        <TextInput
          style={[styles.input, styles.inputMulti]}
          placeholder="A few words about you"
          placeholderTextColor="#555"
          multiline
          numberOfLines={3}
          value={bio}
          onChangeText={setBio}
        />

        <Text style={styles.label}>Interests</Text>

        {/* Selected interests */}
        {availableFor.length > 0 && (
          <View style={styles.chips}>
            {availableFor.map(opt => (
              <TouchableOpacity
                key={opt}
                style={styles.chipSelected}
                onPress={() => toggleInterest(opt)}
              >
                <Text style={styles.chipTextSelected}>{opt} ×</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Search */}
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            value={interestQuery}
            onChangeText={setInterestQuery}
            placeholder="Search interests..."
            placeholderTextColor="#555"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (showCustomAdd) toggleInterest(interestQuery.trim());
            }}
          />
          {showCustomAdd && (
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => toggleInterest(interestQuery.trim())}
            >
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Suggestions grid */}
        <View style={styles.suggestionsGrid}>
          {interestSuggestions.map(opt => (
            <TouchableOpacity
              key={opt}
              style={styles.chip}
              onPress={() => toggleInterest(opt)}
            >
              <Text style={styles.chipText}>{opt}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {availableFor.length > 0 && (
          <Text style={styles.interestCount}>{availableFor.length}/{MAX_INTERESTS} selected</Text>
        )}

        <TouchableOpacity
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleCreate}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#0a0a0a" />
            : <Text style={styles.btnText}>Enroll Biometric &amp; Create</Text>
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
  sub: { fontSize: 14, color: '#888', marginBottom: 24, lineHeight: 20 },

  avatarWrap: { alignItems: 'center', marginBottom: 24 },
  avatarImg: { width: 88, height: 88, borderRadius: 44, marginBottom: 8 },
  avatarPlaceholder: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#1a1a1a',
    borderWidth: 2,
    borderColor: '#333',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  avatarPlaceholderText: { color: '#555', fontSize: 28, lineHeight: 32 },
  avatarHint: { color: '#666', fontSize: 13 },

  label: { fontSize: 13, fontWeight: '600', color: '#aaa', marginBottom: 6, marginTop: 20, textTransform: 'uppercase', letterSpacing: 0.8 },
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    backgroundColor: '#1a1a1a',
  },
  chipSelected: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: '#7c3aed',
  },
  chipText: { color: '#aaa', fontSize: 13 },
  chipTextSelected: { color: '#fff', fontSize: 13, fontWeight: '500' },

  searchRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  searchInput: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  addBtn: {
    backgroundColor: '#F2E58F',
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: { color: '#000', fontWeight: '700', fontSize: 14 },

  suggestionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  interestCount: { color: '#555', fontSize: 12, marginTop: 8 },
  btn: {
    marginTop: 40,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#0a0a0a', fontSize: 16, fontWeight: '700' },
});

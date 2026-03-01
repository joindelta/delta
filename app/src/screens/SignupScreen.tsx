/**
 * SignupScreen
 *
 * Flow:
 * 1. Generate keypair (calls Rust via UniFFI)
 * 2. Enroll biometric — sets the key in iOS Keychain / Android Keystore
 * 3. Collect profile fields: username, avatar placeholder, bio, available_for
 * 4. Navigate to Main on success
 */

import React, { useState } from 'react';
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

type Props = NativeStackScreenProps<AuthStackParamList, 'Signup'>;

const AVAILABLE_FOR_OPTIONS = ['Networking', 'Coffee', 'Collaboration', 'Mentorship'];

export function SignupScreen({ navigation: _navigation }: Props) {
  const createAccount = useAuthStore(s => s.createAccount);
  const { setProfilePicUri, setLocalUsername, createOrUpdateProfile } = useProfileStore();

  const [username, setUsername]         = useState('');
  const [bio, setBio]                   = useState('');
  const [availableFor, setAvailableFor] = useState<string[]>([]);
  const [profilePicUri, setLocalPicUri] = useState<string | null>(null);
  const [loading, setLoading]           = useState(false);

  function toggleAvailableFor(option: string) {
    setAvailableFor(prev =>
      prev.includes(option) ? prev.filter(o => o !== option) : [...prev, option],
    );
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
      await createAccount();
      // Persist username locally (reliable fallback) and to the network profile.
      await setLocalUsername(username.trim());
      await createOrUpdateProfile(username.trim(), bio.trim() || null, availableFor);
      if (profilePicUri) {
        await setProfilePicUri(profilePicUri);
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

        <Text style={styles.label}>Available for</Text>
        <View style={styles.chips}>
          {AVAILABLE_FOR_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt}
              style={[styles.chip, availableFor.includes(opt) && styles.chipSelected]}
              onPress={() => toggleAvailableFor(opt)}
            >
              <Text style={[styles.chipText, availableFor.includes(opt) && styles.chipTextSelected]}>
                {opt}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  chipSelected: { backgroundColor: '#fff', borderColor: '#fff' },
  chipText: { color: '#aaa', fontSize: 14 },
  chipTextSelected: { color: '#0a0a0a', fontWeight: '600' },
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

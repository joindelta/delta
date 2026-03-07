import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Image,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { X, Camera, Image as ImageIcon } from 'lucide-react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import RNFS from 'react-native-fs';
import { useProfileStore } from '../stores/useProfileStore';
import { uploadBlob } from '../ffi/gardensCore';

export function EditProfileSheet(props: SheetProps<'edit-profile-sheet'>) {
  const { myProfile, localUsername, fetchMyProfile, profilePicUri, setProfilePicUri } = useProfileStore();
  
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [avatarBlobId, setAvatarBlobId] = useState<string | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProfile = async () => {
    setLoading(true);
    try {
      await fetchMyProfile();
      const profile = myProfile;
      if (profile) {
        setDisplayName(profile.username || localUsername || '');
        setBio(profile.bio || '');
      } else {
        setDisplayName(localUsername || '');
      }
      if (profilePicUri) {
        setAvatarUri(profilePicUri);
      }
      if (profile?.avatarBlobId) {
        setAvatarBlobId(profile.avatarBlobId);
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      setLoading(false);
    }
  };

  const pickImage = async (type: 'avatar' | 'cover') => {
    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        quality: 0.8,
        selectionLimit: 1,
      });

      if (result.assets && result.assets[0] && result.assets[0].uri) {
        const asset = result.assets[0];
        if (type === 'avatar') {
          setAvatarUri(asset.uri);
          await setProfilePicUri(asset.uri);
          try {
            const base64Data = await RNFS.readFile(asset.uri, 'base64');
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
            const lookup = new Uint8Array(256);
            for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
            const bytes = base64Data.replace(/=+$/, '');
            const output = new Uint8Array((bytes.length * 3) >> 2);
            let ptr = 0;
            for (let i = 0; i < bytes.length; i += 4) {
              const a = lookup[bytes.charCodeAt(i)], b = lookup[bytes.charCodeAt(i+1)];
              const c = lookup[bytes.charCodeAt(i+2)], d = lookup[bytes.charCodeAt(i+3)];
              output[ptr++] = (a << 2) | (b >> 4);
              if (i+2 < bytes.length) output[ptr++] = ((b & 15) << 4) | (c >> 2);
              if (i+3 < bytes.length) output[ptr++] = ((c & 3) << 6) | d;
            }
            const mimeType = asset.type || 'image/jpeg';
            const blobId = await uploadBlob(output.subarray(0, ptr), mimeType, null);
            setAvatarBlobId(blobId);
          } catch (e) {
            console.warn('[profile] Failed to upload avatar blob:', e);
          }
        } else {
          setCoverUri(asset.uri);
        }
      }
    } catch {
      Alert.alert('Error', 'Failed to pick image');
    }
  };

  const handleSave = async () => {
    if (!displayName.trim()) {
      Alert.alert('Error', 'Display name is required');
      return;
    }

    setSaving(true);
    try {
      const { createOrUpdateProfile: storeCreate } = useProfileStore.getState();
      await storeCreate(
        displayName.trim(),
        bio.trim() || null,
        myProfile?.availableFor || [],
        myProfile?.isPublic || false,
        avatarBlobId,
      );

      SheetManager.hide('edit-profile-sheet');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  function close() {
    SheetManager.hide('edit-profile-sheet');
  }

  const initials = (displayName || localUsername || '?').slice(0, 2).toUpperCase();

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
        <Text style={s.headerTitle}>Edit Profile</Text>
        <TouchableOpacity 
          style={[s.saveBtn, saving && s.saveBtnDisabled]} 
          onPress={handleSave}
          disabled={saving || loading}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#000" />
          ) : (
            <Text style={s.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView style={s.content} keyboardShouldPersistTaps="handled">
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : (
          <>
            {/* Cover Photo */}
            <View style={s.section}>
              <Text style={s.label}>Cover Photo</Text>
              <TouchableOpacity 
                style={s.coverContainer} 
                onPress={() => pickImage('cover')}
              >
                {coverUri ? (
                  <Image source={{ uri: coverUri }} style={s.coverImage} />
                ) : (
                  <View style={s.coverPlaceholder}>
                    <ImageIcon size={32} color="#555" />
                    <Text style={s.coverText}>Tap to add cover photo</Text>
                  </View>
                )}
                <View style={s.coverOverlay}>
                  <Camera size={20} color="#fff" />
                </View>
              </TouchableOpacity>
            </View>

            {/* Avatar */}
            <View style={s.section}>
              <Text style={s.label}>Profile Picture</Text>
              <View style={s.avatarSection}>
                <TouchableOpacity 
                  style={s.avatarContainer} 
                  onPress={() => pickImage('avatar')}
                >
                  {avatarUri ? (
                    <Image source={{ uri: avatarUri }} style={s.avatarImage} />
                  ) : (
                    <View style={s.avatarPlaceholder}>
                      <Text style={s.avatarInitials}>{initials}</Text>
                    </View>
                  )}
                  <View style={s.avatarOverlay}>
                    <Camera size={16} color="#fff" />
                  </View>
                </TouchableOpacity>
              </View>
            </View>

            {/* Display Name */}
            <View style={s.section}>
              <Text style={s.label}>Display Name</Text>
              <TextInput
                style={s.input}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Enter your display name"
                placeholderTextColor="#555"
                maxLength={50}
              />
              <Text style={s.characterCount}>{displayName.length}/50</Text>
            </View>

            {/* Bio */}
            <View style={s.section}>
              <Text style={s.label}>Bio</Text>
              <TextInput
                style={[s.input, s.bioInput]}
                value={bio}
                onChangeText={setBio}
                placeholder="Tell people about yourself"
                placeholderTextColor="#555"
                multiline
                numberOfLines={4}
                maxLength={500}
                textAlignVertical="top"
              />
              <Text style={s.characterCount}>{bio.length}/500</Text>
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
  saveBtn: {
    backgroundColor: '#F2E58F',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#000', fontSize: 14, fontWeight: '600' },
  
  content: { marginTop: 16 },
  center: { paddingVertical: 40, alignItems: 'center' },
  
  section: {
    marginBottom: 24,
  },
  label: {
    color: '#888',
    fontSize: 13,
    marginBottom: 12,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  
  coverContainer: {
    height: 120,
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    position: 'relative',
    overflow: 'hidden',
  },
  coverImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  coverPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverText: {
    color: '#555',
    marginTop: 8,
    fontSize: 13,
  },
  coverOverlay: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  avatarSection: {
    alignItems: 'flex-start',
  },
  avatarContainer: {
    position: 'relative',
  },
  avatarImage: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  avatarOverlay: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#111',
  },
  
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    color: '#fff',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#333',
  },
  bioInput: {
    height: 100,
    paddingTop: 16,
  },
  characterCount: {
    color: '#555',
    fontSize: 12,
    textAlign: 'right',
    marginTop: 4,
  },
});

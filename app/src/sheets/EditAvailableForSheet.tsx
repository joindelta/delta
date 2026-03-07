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
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { X, Plus, Trash2 } from 'lucide-react-native';
import { useProfileStore } from '../stores/useProfileStore';
import { createOrUpdateProfile } from '../ffi/gardensCore';

const SUGGESTED_TAGS = [
  'Collaboration',
  'Hiring',
  'Consulting',
  'Mentorship',
  'Open Source',
  'Networking',
  'Investing',
  'Speaking',
];

export function EditAvailableForSheet(props: SheetProps<'edit-available-for-sheet'>) {
  const { myProfile, fetchMyProfile } = useProfileStore();
  
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProfile = async () => {
    setLoading(true);
    try {
      await fetchMyProfile();
      const profile = myProfile;
      if (profile?.availableFor) {
        setTags(profile.availableFor);
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      setLoading(false);
    }
  };

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    if (tags.includes(trimmed)) {
      Alert.alert('Error', 'This tag already exists');
      return;
    }
    if (tags.length >= 10) {
      Alert.alert('Error', 'Maximum 10 tags allowed');
      return;
    }
    setTags([...tags, trimmed]);
    setNewTag('');
  };

  const removeTag = (index: number) => {
    setTags(tags.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await createOrUpdateProfile(
        myProfile?.username || '',
        myProfile?.bio || null,
        tags,
        myProfile?.isPublic || false,
        myProfile?.avatarBlobId || null,
        myProfile?.emailEnabled || false
      );

      await fetchMyProfile();
      SheetManager.hide('edit-available-for-sheet');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  function close() {
    SheetManager.hide('edit-available-for-sheet');
  }

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
        <Text style={s.headerTitle}>Available For</Text>
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
            <Text style={s.description}>
              Let people know what you're open to. These tags will be visible on your public profile.
            </Text>

            {/* Add new tag */}
            <View style={s.addSection}>
              <TextInput
                style={s.input}
                value={newTag}
                onChangeText={setNewTag}
                placeholder="Add a tag..."
                placeholderTextColor="#555"
                maxLength={30}
                onSubmitEditing={() => addTag(newTag)}
              />
              <TouchableOpacity 
                style={[s.addBtn, !newTag.trim() && s.addBtnDisabled]} 
                onPress={() => addTag(newTag)}
                disabled={!newTag.trim()}
              >
                <Plus size={20} color={newTag.trim() ? '#000' : '#555'} />
              </TouchableOpacity>
            </View>

            {/* Current tags */}
            {tags.length > 0 && (
              <View style={s.tagsSection}>
                <Text style={s.sectionLabel}>Your Tags</Text>
                <View style={s.tagsList}>
                  {tags.map((tag, index) => (
                    <View key={index} style={s.tag}>
                      <Text style={s.tagText}>{tag}</Text>
                      <TouchableOpacity onPress={() => removeTag(index)} style={s.tagRemove}>
                        <Trash2 size={14} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Suggested tags */}
            <View style={s.suggestedSection}>
              <Text style={s.sectionLabel}>Suggested</Text>
              <View style={s.tagsList}>
                {SUGGESTED_TAGS.filter(tag => !tags.includes(tag)).map((tag) => (
                  <TouchableOpacity 
                    key={tag} 
                    style={s.suggestedTag}
                    onPress={() => addTag(tag)}
                  >
                    <Text style={s.suggestedTagText}>{tag}</Text>
                    <Plus size={12} color="#F2E58F" />
                  </TouchableOpacity>
                ))}
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
    minHeight: 400,
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
  
  description: {
    color: '#888',
    fontSize: 14,
    marginBottom: 20,
    lineHeight: 20,
  },
  
  addSection: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    color: '#fff',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#333',
  },
  addBtn: {
    width: 48,
    backgroundColor: '#F2E58F',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnDisabled: {
    backgroundColor: '#222',
  },
  
  tagsSection: {
    marginBottom: 24,
  },
  sectionLabel: {
    color: '#888',
    fontSize: 12,
    textTransform: 'uppercase',
    fontWeight: '600',
    marginBottom: 12,
  },
  tagsList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#7c3aed',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  tagText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  tagRemove: {
    padding: 2,
  },
  
  suggestedSection: {
    marginBottom: 16,
  },
  suggestedTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: '#333',
  },
  suggestedTagText: {
    color: '#aaa',
    fontSize: 14,
  },
});

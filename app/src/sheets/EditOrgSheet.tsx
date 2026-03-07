import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import ActionSheet, { SheetManager } from 'react-native-actions-sheet';

interface EditOrgSheetProps {
  sheetId: string;
  payload?: {
    orgId: string;
    currentName?: string;
    currentDescription?: string | null;
    onSave?: () => void;
  };
}

export function EditOrgSheet(props: EditOrgSheetProps) {
  const { orgId, currentName, currentDescription, onSave } = props.payload || {};
  const [name, setName] = useState(currentName || '');
  const [description, setDescription] = useState(currentDescription || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Update state when payload changes
  useEffect(() => {
    setName(currentName || '');
    setDescription(currentDescription || '');
    setError('');
  }, [currentName, currentDescription]);

  async function handleSave() {
    if (!name.trim()) {
      setError('Organization name is required');
      return;
    }

    if (name.trim() === currentName && description.trim() === (currentDescription || '')) {
      SheetManager.hide('edit-org-sheet');
      return;
    }

    setSaving(true);
    setError('');

    try {
      // Import dynamically to avoid issues
      const { updateOrg } = await import('../ffi/gardensCore');
      await updateOrg(
        orgId!,
        name.trim(),
        null,
        description.trim() || null,
        null,
        null,
        null,
        null,
        null,
        null
      );
      onSave?.();
      SheetManager.hide('edit-org-sheet');
    } catch (err: any) {
      setError(err.message || 'Failed to update organization');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionSheet id={props.sheetId} containerStyle={styles.sheet}>
      <View style={styles.container}>
        <Text style={styles.title}>Edit Organization</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.field}>
          <Text style={styles.label}>Organization Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Enter organization name"
            placeholderTextColor="#555"
            autoFocus
            editable={!saving}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Description</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Add a description (optional)"
            placeholderTextColor="#555"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            editable={!saving}
          />
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.saveBtnText}>Save Changes</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={() => SheetManager.hide('edit-org-sheet')}
          disabled={saving}
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  container: {
    padding: 20,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 20,
    textAlign: 'center',
  },
  error: {
    color: '#ef4444',
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
  },
  field: {
    marginBottom: 16,
  },
  label: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#fff',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#333',
  },
  textArea: {
    height: 80,
    paddingTop: 12,
  },
  saveBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelBtn: {
    backgroundColor: 'transparent',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  cancelBtnText: {
    color: '#888',
    fontSize: 16,
    fontWeight: '600',
  },
});

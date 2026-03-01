import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  Alert,
  Share,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/RootNavigator';
import { useOrgsStore } from '../stores/useOrgsStore';
import { uploadBlob, getPkarrUrl } from '../ffi/deltaCore';
import { BlobImage } from '../components/BlobImage';
import { PublicIdentityCard } from '../components/PublicIdentityCard';

// Image picker import - will be conditionally available
let launchImageLibrary: any;
try {
  const imagePicker = require('react-native-image-picker');
  launchImageLibrary = imagePicker.launchImageLibrary;
} catch {
  // Image picker not available
}

type Props = NativeStackScreenProps<MainStackParamList, 'OrgSettings'>;

function SettingsRow({
  label,
  description,
  soon,
  onPress,
}: {
  label: string;
  description?: string;
  soon?: boolean;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      style={s.row}
      disabled={soon || !onPress}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={s.rowContent}>
        <Text style={s.rowLabel}>{label}</Text>
        {description && <Text style={s.rowDesc}>{description}</Text>}
      </View>
      {soon ? (
        <View style={s.soonBadge}>
          <Text style={s.soonText}>Soon</Text>
        </View>
      ) : (
        <Text style={s.chevron}>›</Text>
      )}
    </TouchableOpacity>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={s.row}>
      <View style={s.rowContent}>
        <Text style={s.rowLabel}>{label}</Text>
        {description && <Text style={s.rowDesc}>{description}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: '#333', true: '#3b82f6' }}
        thumbColor="#fff"
      />
    </View>
  );
}

export function OrgSettingsScreen({ route }: Props) {
  const { orgId, orgName } = route.params;
  const { orgs, updateOrg, fetchMyOrgs } = useOrgsStore();

  const [isUploading, setIsUploading] = useState(false);
  const [coverBlobId, setCoverBlobId] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [pkarrUrl, setPkarrUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // Get current org data
  const org = orgs.find(o => o.orgId === orgId);

  useEffect(() => {
    if (org) {
      setCoverBlobId(org.coverBlobId);
      setIsPublic(org.isPublic);
      setLoading(false);
      
      // Generate pkarr URL from creator key
      if (org.creatorKey) {
        try {
          const url = getPkarrUrl(org.creatorKey);
          setPkarrUrl(url);
        } catch {
          // Failed to get pkarr URL
        }
      }
    }
  }, [org]);

  const handleTogglePublic = async (value: boolean) => {
    setSaving(true);
    try {
      await updateOrg(orgId, undefined, undefined, undefined, undefined, undefined, value);
      setIsPublic(value);
      await fetchMyOrgs();
      
      if (value) {
        Alert.alert(
          'Public Organization Enabled',
          'Your organization is now published to the DHT and can be discovered by others.'
        );
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to update organization');
      setIsPublic(!value);
    } finally {
      setSaving(false);
    }
  };

  const handleShareCommunity = async () => {
    if (!pkarrUrl) {
      Alert.alert('Error', 'Public URL not available');
      return;
    }
    
    try {
      await Share.share({
        message: `Join ${orgName} on Delta: ${pkarrUrl}`,
        url: pkarrUrl,
      });
    } catch {
      // Share cancelled
    }
  };

  const handleSelectCoverPhoto = async () => {
    if (!launchImageLibrary) {
      Alert.alert('Error', 'Image picker is not available');
      return;
    }

    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        quality: 0.8,
        maxWidth: 1200,
        maxHeight: 600,
        selectionLimit: 1,
      });

      if (result.didCancel || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      if (!asset.uri) {
        Alert.alert('Error', 'Could not get image URI');
        return;
      }

      await uploadCoverPhoto(asset.uri, asset.type || 'image/jpeg');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to select image');
    }
  };

  const uploadCoverPhoto = async (uri: string, mimeType: string) => {
    setIsUploading(true);
    try {
      // Read file as base64
      const response = await fetch(uri);
      const blob = await response.blob();

      // Convert blob to Uint8Array
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
      const uint8Array = new Uint8Array(arrayBuffer);

      // Upload blob
      const newBlobId = await uploadBlob(uint8Array, mimeType, null);

      // Update org with new cover blob ID
      await updateOrg(orgId, undefined, undefined, undefined, undefined, newBlobId, undefined);

      // Refresh orgs to get updated data
      await fetchMyOrgs();

      setCoverBlobId(newBlobId);
      Alert.alert('Success', 'Cover photo updated');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to upload cover photo');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveCoverPhoto = async () => {
    Alert.alert(
      'Remove Cover Photo',
      'Are you sure you want to remove the cover photo?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await updateOrg(orgId, undefined, undefined, undefined, undefined, undefined as any, undefined);
              await fetchMyOrgs();
              setCoverBlobId(undefined as any);
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to remove cover photo');
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Cover Photo Preview */}
      {coverBlobId && (
        <View style={s.coverPreviewContainer}>
          <BlobImage blobHash={coverBlobId} style={s.coverPreview} />
          <TouchableOpacity
            style={s.removeCoverBtn}
            onPress={handleRemoveCoverPhoto}
          >
            <Text style={s.removeCoverText}>Remove</Text>
          </TouchableOpacity>
        </View>
      )}

      <Section title="General">
        <SettingsRow label="Organization Name" description={orgName} soon />
        <SettingsRow label="Description" description="Add a description" soon />
        
        <ToggleRow
          label="Public Organization"
          description="Publish to DHT for discovery"
          value={isPublic}
          onChange={handleTogglePublic}
          disabled={saving}
        />
        {saving && (
          <View style={s.savingRow}>
            <ActivityIndicator size="small" color="#888" />
            <Text style={s.savingText}>Updating...</Text>
          </View>
        )}
        
        {isPublic && pkarrUrl && org && (
          <View style={s.cardContainer}>
            <PublicIdentityCard
              pkarrUrl={pkarrUrl}
              publicKeyHex={org.creatorKey}
              label={orgName}
            />
            <TouchableOpacity style={s.shareBtn} onPress={handleShareCommunity}>
              <Text style={s.shareBtnText}>🔗 Share Community Link</Text>
            </TouchableOpacity>
          </View>
        )}
      </Section>

      <Section title="Appearance">
        <SettingsRow
          label="Cover Photo"
          description={coverBlobId ? 'Change cover photo' : 'Add a cover photo'}
          onPress={handleSelectCoverPhoto}
        />
        {isUploading && (
          <View style={s.uploadingRow}>
            <ActivityIndicator size="small" color="#888" />
            <Text style={s.uploadingText}>Uploading...</Text>
          </View>
        )}
        <SettingsRow label="Organization Icon" soon />
      </Section>

      <Section title="Members">
        <SettingsRow label="Roles & Permissions" soon />
        <SettingsRow label="Bans & Restrictions" soon />
      </Section>

      <Section title="Danger Zone">
        <TouchableOpacity style={s.dangerRow} disabled>
          <Text style={s.dangerLabel}>Delete Organization</Text>
          <View style={s.soonBadge}>
            <Text style={s.soonText}>Soon</Text>
          </View>
        </TouchableOpacity>
      </Section>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { paddingVertical: 24, paddingHorizontal: 16 },
  center: { alignItems: 'center', justifyContent: 'center' },

  coverPreviewContainer: {
    marginBottom: 24,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  coverPreview: {
    width: '100%',
    height: 120,
  },
  removeCoverBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  removeCoverText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
  },

  section: { marginBottom: 32 },
  sectionTitle: {
    color: '#555',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionBody: {
    backgroundColor: '#111',
    borderRadius: 12,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  rowContent: { flex: 1 },
  rowLabel: { color: '#fff', fontSize: 15 },
  rowDesc: { color: '#555', fontSize: 12, marginTop: 2 },
  chevron: { color: '#444', fontSize: 20, marginLeft: 8 },

  soonBadge: {
    backgroundColor: '#1e1e1e',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  soonText: { color: '#555', fontSize: 11, fontWeight: '600' },

  savingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  savingText: {
    color: '#888',
    fontSize: 12,
    marginLeft: 8,
  },

  uploadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  uploadingText: {
    color: '#888',
    fontSize: 12,
    marginLeft: 8,
  },

  cardContainer: {
    padding: 12,
    backgroundColor: '#0a0a0a',
  },

  shareBtn: {
    backgroundColor: '#1e1e1e',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  shareBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },

  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  dangerLabel: { color: '#ef4444', fontSize: 15, flex: 1 },
});

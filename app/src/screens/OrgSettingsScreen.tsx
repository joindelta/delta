import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  ActivityIndicator,
  Alert,
  Share,
  Clipboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LOCATION_STORAGE_KEY, publishProfileMeta } from '../sheets/LocationPickerSheet';
import { SheetManager } from 'react-native-actions-sheet';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/RootNavigator';
import RNFS from 'react-native-fs';
import { useOrgsStore } from '../stores/useOrgsStore';
import { useProfileStore } from '../stores/useProfileStore';
import { useAuthStore } from '../stores/useAuthStore';
import { uploadBlob, getPkarrUrl, getPkarrUrlFromZ32, listOrgMembers, setOrgCooldown, setRoomCooldown, initNetwork, isNetworkInitialized } from '../ffi/gardensCore';
import { BlobImage } from '../components/BlobImage';
import { PublicIdentityCard } from '../components/PublicIdentityCard';
import { DefaultCoverShader } from '../components/DefaultCoverShader';
import { normalizeCustomEmojiList, parseCustomEmoji } from '../utils/customEmoji';

// Helper to convert base64 to Uint8Array without atob
function base64ToBytes(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  const len = base64.length;
  let padding = 0;
  if (base64[len - 2] === '=') padding = 2;
  else if (base64[len - 1] === '=') padding = 1;

  const bytesLen = (len * 3 / 4) - padding;
  const bytes = new Uint8Array(bytesLen);

  let i = 0;
  let j = 0;
  while (i < len) {
    const a = lookup[base64.charCodeAt(i++)];
    const b = lookup[base64.charCodeAt(i++)];
    const c = lookup[base64.charCodeAt(i++)];
    const d = lookup[base64.charCodeAt(i++)];

    bytes[j++] = (a << 2) | (b >> 4);
    if (j < bytesLen) bytes[j++] = ((b & 15) << 4) | (c >> 2);
    if (j < bytesLen) bytes[j++] = ((c & 3) << 6) | d;
  }

  return bytes;
}

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

export function OrgSettingsScreen({ route, navigation }: Props) {
  const { orgId, orgName } = route.params;
  const { orgs, rooms, updateOrg, fetchMyOrgs, fetchRooms, deleteOrg: deleteOrgFromStore, leaveOrg } = useOrgsStore();
  const { myProfile } = useProfileStore();
  const { keypair } = useAuthStore();

  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingIcon, setIsUploadingIcon] = useState(false);
  const [coverBlobId, setCoverBlobId] = useState<string | null>(null);
  const [avatarBlobId, setAvatarBlobId] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [orgEmailEnabled, setOrgEmailEnabled] = useState(false);
  const [pkarrUrl, setPkarrUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [memberCount, setMemberCount] = useState(0);
  const [welcomeDraft, setWelcomeDraft] = useState('');
  const [welcomeSaving, setWelcomeSaving] = useState(false);
  const [emojiCode, setEmojiCode] = useState('');
  const [emojiBusy, setEmojiBusy] = useState(false);
  const [emojiStatus, setEmojiStatus] = useState<string | null>(null);
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [orgLocation, setOrgLocation] = useState<string | null>(null);
  const [orgCooldownDraft, setOrgCooldownDraft] = useState('');
  const [channelCooldowns, setChannelCooldowns] = useState<Record<string, string>>({});

  // Get current org data
  const org = orgs.find(o => o.orgId === orgId);
  const myKey = myProfile?.publicKey ?? keypair?.publicKeyHex ?? '';
  const isCreator = !!org?.creatorKey && !!myKey && org.creatorKey === myKey;
  const orgRooms = useMemo(() => rooms[orgId] ?? [], [rooms, orgId]);
  const emojiRoomId = orgRooms.find(r => r.name === 'general')?.roomId ?? orgRooms[0]?.roomId ?? null;
  const customEmojiList = parseCustomEmoji(org?.customEmojiJson);

  useEffect(() => {
    if (org) {
      setCoverBlobId(org.coverBlobId);
      setAvatarBlobId(org.avatarBlobId);
      setIsPublic(org.isPublic);
      setOrgEmailEnabled(org.emailEnabled ?? false);
      setWelcomeDraft(org.welcomeText ?? '');
      setOrgCooldownDraft(org.orgCooldownSecs?.toString() ?? '');
      setLoading(false);
      
      // Generate pkarr URL from org's public key (z32 encoded)
      try {
        let url: string;
        if (org.orgPubkey) {
          url = getPkarrUrlFromZ32(org.orgPubkey);
        } else {
          url = getPkarrUrl(org.creatorKey);
        }
        setPkarrUrl(url);
      } catch {
        // Failed to get pkarr URL
      }
      
      // Load member count
      loadMemberCount();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  useEffect(() => {
    fetchRooms(orgId).catch(() => {});
    AsyncStorage.getItem(`${LOCATION_STORAGE_KEY}:org:${orgId}`).then(v => setOrgLocation(v)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  useEffect(() => {
    const map: Record<string, string> = {};
    orgRooms.forEach(r => {
      map[r.roomId] = r.roomCooldownSecs?.toString() ?? '';
    });
    setChannelCooldowns(map);
  }, [orgRooms]);

  
  async function loadMemberCount() {
    try {
      const members = await listOrgMembers(orgId);
      setMemberCount(members.length);
    } catch {
      // Failed to load member count
    }
  }

  const handleTogglePublic = async (value: boolean) => {
    setSaving(true);
    try {
      console.log('[OrgSettings] toggle public ->', { orgId, value });
      await updateOrg(orgId, null, null, null, null, null, null, null, null, value);
      setIsPublic(value);
      await fetchMyOrgs();
      const refreshed = useOrgsStore.getState().orgs.find(o => o.orgId === orgId);
      console.log('[OrgSettings] after fetchMyOrgs isPublic =', refreshed?.isPublic);
      
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

  const handleToggleOrgEmail = async (value: boolean) => {
    setOrgEmailEnabled(value);
    try {
      await updateOrg(orgId, null, null, null, null, null, null, null, null, null, value);
    } catch {
      setOrgEmailEnabled(!value);
    }
  };

  const GARDENS_BASE_URL = 'https://gardens.app';

  const handleShareCommunity = async () => {
    if (!pkarrUrl) {
      Alert.alert('Error', 'Public URL not available');
      return;
    }
    const z32Key = pkarrUrl.startsWith('pk:') ? pkarrUrl.slice(3) : pkarrUrl;
    const webLink = `${GARDENS_BASE_URL}/pk/${z32Key}`;
    try {
      await Share.share({
        message: `Join ${orgName} on Gardens: ${webLink}`,
        url: webLink,
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
      // Read file using react-native-fs (works for both local and remote URIs)
      const base64Data = await RNFS.readFile(uri, 'base64');
      const uint8Array = base64ToBytes(base64Data);

      // Upload blob
      const newBlobId = await uploadBlob(uint8Array, mimeType, null);

      // Update org with new cover blob ID
      await updateOrg(orgId, null, null, null, null, newBlobId, null, null, null, null);

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

  const handleDeleteOrg = () => {
    Alert.alert(
      'Delete Organization',
      `Are you sure you want to delete "${orgName}"? This action cannot be undone and all data will be permanently lost.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Final Confirmation',
              `This will permanently delete "${orgName}".`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Confirm Delete',
                  style: 'destructive',
                  onPress: async () => {
                    if (deletingOrg) return;
                    setDeletingOrg(true);
                    try {
                      await deleteOrgFromStore(orgId);
                      navigation.navigate('Home');
                    } catch (err: any) {
                      Alert.alert('Error', err.message || 'Failed to delete organization');
                    } finally {
                      setDeletingOrg(false);
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  const handleLeaveOrg = () => {
    Alert.alert(
      'Leave Organization',
      `Leave "${orgName}"? You will lose access to its rooms and messages.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await leaveOrg(orgId);
              navigation.navigate('Home');
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to leave organization');
            }
          },
        },
      ]
    );
  };

  const handleEditOrg = () => {
    SheetManager.show('edit-org-sheet', {
      payload: {
        orgId,
        currentName: org?.name || orgName,
        currentDescription: org?.description,
        onSave: () => {
          fetchMyOrgs();
        },
      },
    });
  };

  const handleSelectIcon = async () => {
    if (!launchImageLibrary) {
      Alert.alert('Error', 'Image picker is not available');
      return;
    }

    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        quality: 0.8,
        maxWidth: 512,
        maxHeight: 512,
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

      await uploadIcon(asset.uri, asset.type || 'image/jpeg');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to select image');
    }
  };

  const uploadIcon = async (uri: string, mimeType: string) => {
    setIsUploadingIcon(true);
    try {
      // Read file using react-native-fs (works for both local and remote URIs)
      const base64Data = await RNFS.readFile(uri, 'base64');
      const uint8Array = base64ToBytes(base64Data);

      // Upload blob
      const newBlobId = await uploadBlob(uint8Array, mimeType, null);

      // Update org with new avatar blob ID
      await updateOrg(orgId, null, null, null, newBlobId, null, null, null, null, null);

      // Refresh orgs to get updated data
      await fetchMyOrgs();

      setAvatarBlobId(newBlobId);
      Alert.alert('Success', 'Organization icon updated');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to upload icon');
    } finally {
      setIsUploadingIcon(false);
    }
  };

  const handleNavigateToMembers = () => {
    // @ts-ignore - navigation type not fully defined
    navigation.navigate('MemberList', { orgId, orgName });
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
              await updateOrg(orgId, null, null, null, null, null, null, null, null, null);
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

  const handleSaveWelcome = async () => {
    setWelcomeSaving(true);
    try {
      await updateOrg(orgId, null, null, null, null, null, welcomeDraft.trim(), null, null, null);
      await fetchMyOrgs();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to save welcome note');
    } finally {
      setWelcomeSaving(false);
    }
  };

  const handleAddEmoji = async () => {
    setEmojiStatus(null);
    if (!launchImageLibrary) {
      Alert.alert('Error', 'Image picker is not available');
      return;
    }
    if (!emojiCode.trim()) {
      Alert.alert('Error', 'Enter a :code: for the emoji');
      return;
    }
    if (!emojiRoomId) {
      Alert.alert('Error', 'No channel available for emoji encryption');
      return;
    }
    let code = emojiCode.trim();
    if (!code.startsWith(':')) code = `:${code}`;
    if (!code.endsWith(':')) code = `${code}:`;

    setEmojiBusy(true);
    try {
      setEmojiStatus('Initializing network...');
      const ok = await isNetworkInitialized();
      if (!ok) await initNetwork(null);
      setEmojiStatus('Opening image picker...');
      const result = await launchImageLibrary({
        mediaType: 'photo',
        quality: 0.9,
        selectionLimit: 1,
        includeBase64: true,
      });
      if (result?.errorCode) {
        Alert.alert('Error', result.errorMessage || 'Failed to select image');
        return;
      }
      if (result.didCancel || !result.assets || result.assets.length === 0) {
        Alert.alert('Error', 'No image selected');
        return;
      }
      setEmojiStatus('Reading image...');
      const asset = result.assets[0];
      const mimeType = asset.type || 'image/png';
      let uint8Array: Uint8Array;
      if (asset.base64) {
        uint8Array = base64ToBytes(asset.base64);
      } else if (asset.uri) {
        const base64Data = await RNFS.readFile(asset.uri, 'base64');
        uint8Array = base64ToBytes(base64Data);
      } else {
        Alert.alert('Error', 'Could not get image data');
        return;
      }
      setEmojiStatus('Uploading emoji...');
      const blobId = await uploadBlob(uint8Array, mimeType, emojiRoomId);
      if (!blobId) {
        Alert.alert('Error', 'Failed to upload emoji');
        return;
      }

      const updated = normalizeCustomEmojiList([
        ...customEmojiList.filter(e => e.code !== code),
        { code, blobId, mimeType, roomId: emojiRoomId },
      ]);
      setEmojiStatus('Saving emoji to org...');
      await updateOrg(
        orgId,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify(updated),
        null,
        null,
      );
      setEmojiStatus('Refreshing org data...');
      await fetchMyOrgs();
      const refreshed = useOrgsStore.getState().orgs.find(o => o.orgId === orgId);
      if (!refreshed?.customEmojiJson || !String(refreshed.customEmojiJson).includes(code)) {
        setEmojiStatus('Saved, but org data did not include the new emoji. Core may be dropping customEmojiJson.');
        return;
      }
      setEmojiStatus('Emoji saved.');
      setEmojiCode('');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to add emoji');
    } finally {
      setEmojiBusy(false);
    }
  };

  const handleSaveOrgCooldown = async () => {
    const secs = orgCooldownDraft.trim() ? parseInt(orgCooldownDraft.trim(), 10) : 0;
    if (Number.isNaN(secs) || secs < 0) {
      Alert.alert('Error', 'Cooldown must be a positive number');
      return;
    }
    try {
      await setOrgCooldown(orgId, secs);
      await fetchMyOrgs();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to set org cooldown');
    }
  };

  const handleSaveChannelCooldown = async (roomId: string) => {
    const raw = channelCooldowns[roomId] ?? '';
    const secs = raw.trim() ? parseInt(raw.trim(), 10) : 0;
    if (Number.isNaN(secs) || secs < 0) {
      Alert.alert('Error', 'Cooldown must be a positive number');
      return;
    }
    try {
      await setRoomCooldown(orgId, roomId, secs);
      await fetchRooms(orgId);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to set channel cooldown');
    }
  };

  const handleRemoveEmoji = async (code: string) => {
    const updated = normalizeCustomEmojiList(customEmojiList.filter(e => e.code !== code));
    try {
      await updateOrg(
        orgId,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify(updated),
        null,
        null,
      );
      await fetchMyOrgs();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to remove emoji');
    }
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
      <View style={s.coverPreviewContainer}>
        {coverBlobId ? (
          <>
            <BlobImage blobHash={coverBlobId} style={s.coverPreview} />
            <TouchableOpacity
              style={s.removeCoverBtn}
              onPress={handleRemoveCoverPhoto}
            >
              <Text style={s.removeCoverText}>Remove</Text>
            </TouchableOpacity>
          </>
        ) : (
          <DefaultCoverShader width={400} height={120} />
        )}
      </View>

      <Section title="General">
        <SettingsRow 
          label="Organization Name" 
          description={orgName}
          onPress={handleEditOrg}
        />
        <SettingsRow 
          label="Description" 
          description={org?.description || 'Add a description'}
          onPress={handleEditOrg}
        />
        
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
        
        <SettingsRow
          label="Location"
          description={orgLocation ?? 'Not set'}
          onPress={() => {
            SheetManager.show('location-picker-sheet');
            setTimeout(async () => {
              const loco = await AsyncStorage.getItem(LOCATION_STORAGE_KEY).catch(() => null);
              if (!loco) return;
              await AsyncStorage.setItem(`${LOCATION_STORAGE_KEY}:org:${orgId}`, loco);
              setOrgLocation(loco);
              const pubkey = org?.orgPubkey ?? org?.creatorKey;
              if (pubkey) publishProfileMeta(pubkey, { loco });
            }, 1000);
          }}
        />
        {isPublic && pkarrUrl && org && (
          <View style={s.cardContainer}>
            <PublicIdentityCard
              pkarrUrl={pkarrUrl}
              publicKeyHex={org.orgPubkey || org.creatorKey}
              label={orgName}
            />
            <TouchableOpacity style={s.shareBtn} onPress={handleShareCommunity}>
              <Text style={s.shareBtnText}>🔗 Share Community Link</Text>
            </TouchableOpacity>
          </View>
        )}
      </Section>

      <Section title="Email">
        <View style={s.sectionInner}>
          <Text style={s.sectionDesc}>
            Receive email sent to your org's public key address.
          </Text>
          {org?.isPublic ? (
            <>
              <View style={s.addressRow}>
                <Text style={s.addressText} numberOfLines={1}>
                  {org.orgPubkey ? `${org.orgPubkey}@gardens-relay.stereos.workers.dev` : '—'}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    if (org.orgPubkey) {
                      Clipboard.setString(`${org.orgPubkey}@gardens-relay.stereos.workers.dev`);
                    }
                  }}
                >
                  <Text style={s.copyBtn}>Copy</Text>
                </TouchableOpacity>
              </View>
              <View style={s.toggleRow}>
                <Text style={s.toggleLabel}>Receive inbound email</Text>
                <Switch
                  value={orgEmailEnabled}
                  onValueChange={handleToggleOrgEmail}
                  trackColor={{ true: '#F2E58F', false: '#333' }}
                  thumbColor="#fff"
                />
              </View>
            </>
          ) : (
            <Text style={s.hint}>Enable a public org to use email.</Text>
          )}
        </View>
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
        <SettingsRow 
          label="Organization Icon" 
          description={avatarBlobId ? 'Change icon' : 'Upload an icon'}
          onPress={handleSelectIcon}
        />
        {isUploadingIcon && (
          <View style={s.uploadingRow}>
            <ActivityIndicator size="small" color="#888" />
            <Text style={s.uploadingText}>Uploading icon...</Text>
          </View>
        )}
      </Section>

      <Section title="Welcome Note">
        <View style={s.welcomeEditor}>
          <Text style={s.welcomeLabel}>Shown on join and pinned in the drawer</Text>
          <TextInput
            value={welcomeDraft}
            onChangeText={setWelcomeDraft}
            placeholder="Add a short welcome note..."
            placeholderTextColor="#555"
            style={s.welcomeInput}
            multiline
            textAlignVertical="top"
          />
          <TouchableOpacity
            style={[s.welcomeSaveBtn, welcomeSaving && s.welcomeSaveBtnDisabled]}
            onPress={handleSaveWelcome}
            disabled={welcomeSaving}
          >
            {welcomeSaving ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={s.welcomeSaveText}>Save Welcome Note</Text>
            )}
          </TouchableOpacity>
        </View>
      </Section>

      <Section title="Custom Emoji">
        <View style={s.emojiEditor}>
          <Text style={s.emojiLabel}>Add :emoji: codes for custom uploads</Text>
          <View style={s.emojiRow}>
            <TextInput
              value={emojiCode}
              onChangeText={setEmojiCode}
              placeholder=":garden:"
              placeholderTextColor="#555"
              style={s.emojiInput}
              editable={!emojiBusy}
            />
            <TouchableOpacity
              style={[s.emojiAddBtn, emojiBusy && s.emojiAddBtnDisabled]}
              onPress={handleAddEmoji}
              disabled={emojiBusy}
            >
              {emojiBusy ? <ActivityIndicator color="#000" /> : <Text style={s.emojiAddText}>Upload</Text>}
            </TouchableOpacity>
          </View>
          {!!emojiStatus && <Text style={s.emojiStatus}>{emojiStatus}</Text>}
        </View>

        {customEmojiList.map(item => (
          <View key={item.code} style={s.emojiItem}>
            <View style={s.emojiItemLeft}>
              <BlobImage
                blobHash={item.blobId}
                mimeType={item.mimeType}
                roomId={item.roomId}
                style={s.emojiPreview}
              />
              <Text style={s.emojiCode}>{item.code}</Text>
            </View>
            <TouchableOpacity onPress={() => handleRemoveEmoji(item.code)}>
              <Text style={s.emojiRemove}>Remove</Text>
            </TouchableOpacity>
          </View>
        ))}
      </Section>

      <Section title="Moderation">
        <View style={s.emojiEditor}>
          <Text style={s.emojiLabel}>Org slow mode (seconds)</Text>
          <View style={s.emojiRow}>
            <TextInput
              value={orgCooldownDraft}
              onChangeText={setOrgCooldownDraft}
              placeholder="0"
              placeholderTextColor="#555"
              style={s.emojiInput}
              keyboardType="numeric"
            />
            <TouchableOpacity style={s.emojiAddBtn} onPress={handleSaveOrgCooldown}>
              <Text style={s.emojiAddText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>

        {orgRooms.map((room) => (
          <View key={room.roomId} style={s.emojiItem}>
            <View style={s.emojiItemLeft}>
              <Text style={s.emojiCode}>#{room.name}</Text>
            </View>
            <View style={s.channelCooldownRight}>
              <TextInput
                value={channelCooldowns[room.roomId] ?? ''}
                onChangeText={(v) => setChannelCooldowns(prev => ({ ...prev, [room.roomId]: v }))}
                placeholder="0"
                placeholderTextColor="#555"
                style={s.channelCooldownInput}
                keyboardType="numeric"
              />
              <TouchableOpacity style={s.channelCooldownBtn} onPress={() => handleSaveChannelCooldown(room.roomId)}>
                <Text style={s.emojiAddText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </Section>

      <Section title="Members">
        <SettingsRow
          label="Add Members"
          description="Invite via NFC, QR code, or public key"
          onPress={() => navigation.navigate('AddMember', { orgId, orgName })}
        />
        <SettingsRow
          label="Roles & Permissions"
          description={`${memberCount} member${memberCount !== 1 ? 's' : ''}`}
          onPress={handleNavigateToMembers}
        />
        <SettingsRow
          label="Bans & Restrictions"
          description="Manage banned users"
          onPress={handleNavigateToMembers}
        />
      </Section>

      <Section title="Danger Zone">
        {isCreator ? (
          <TouchableOpacity style={s.dangerRow} onPress={handleDeleteOrg}>
            <Text style={s.dangerLabel}>Delete Organization</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.dangerRow} onPress={handleLeaveOrg}>
            <Text style={s.dangerLabel}>Leave Organization</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
        )}
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
  sectionInner: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sectionDesc: { color: '#666', fontSize: 12, marginBottom: 10 },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 12,
  },
  addressText: { color: '#aaa', fontSize: 13, flex: 1 },
  copyBtn: { color: '#F2E58F', fontWeight: '700' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: { color: '#fff', fontSize: 14 },
  hint: { color: '#555', fontSize: 12 },

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

  welcomeEditor: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  welcomeLabel: { color: '#aaa', fontSize: 12 },
  welcomeInput: {
    minHeight: 100,
    backgroundColor: '#0d0d0d',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  welcomeSaveBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#3b82f6',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  welcomeSaveBtnDisabled: { opacity: 0.7 },
  welcomeSaveText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  emojiEditor: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  emojiLabel: { color: '#aaa', fontSize: 12 },
  emojiRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  emojiInput: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  emojiAddBtn: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  emojiAddBtnDisabled: { opacity: 0.7 },
  emojiAddText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  emojiStatus: { color: '#9ca3af', fontSize: 12 },
  emojiItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  emojiItemLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  emojiPreview: { width: 22, height: 22, borderRadius: 4 },
  emojiCode: { color: '#ddd', fontSize: 14 },
  emojiRemove: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
  channelCooldownRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  channelCooldownInput: {
    width: 64,
    backgroundColor: '#0d0d0d',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: '#fff',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    textAlign: 'center',
  },
  channelCooldownBtn: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
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

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { PublicIdentityCard } from '../components/PublicIdentityCard';
import { useProfileStore } from '../stores/useProfileStore';
import { createOrUpdateProfile, getMyProfile, getPkarrUrl } from '../ffi/deltaCore';

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

export function UserSettingsScreen() {
  const { fetchMyProfile, localUsername } = useProfileStore();
  const [profile, setProfile] = useState<import('../stores/useProfileStore').Profile | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [pkarrUrl, setPkarrUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const p = await getMyProfile();
      if (p) {
        setProfile(p);
        setIsPublic(p.isPublic);
        try {
          setPkarrUrl(getPkarrUrl(p.publicKey));
        } catch {
          // pkarrUrl is display-only; don't block load if it fails
        }
      }
      await fetchMyProfile();
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      setLoading(false);
    }
  }, [fetchMyProfile]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  async function handleTogglePublic(value: boolean) {
    const username = profile?.username ?? localUsername;
    if (!username) {
      Alert.alert('Error', 'Please complete your profile setup first.');
      return;
    }

    setSaving(true);
    try {
      await createOrUpdateProfile(
        username,
        profile?.bio ?? null,
        profile?.availableFor ?? [],
        value
      );
      setIsPublic(value);
      await loadProfile();
      
      if (value) {
        Alert.alert(
          'Public Profile Enabled',
          'Your profile is now published to the DHT and can be discovered by others.'
        );
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to update profile');
      // Revert toggle on error
      setIsPublic(!value);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <Section title="Profile">
        <SettingsRow label="Display Name" soon />
        <SettingsRow label="Bio" description="Tell people about yourself" soon />
        <SettingsRow label="Profile Picture" soon />
        <SettingsRow label="Cover Photo" soon />
      </Section>

      <Section title="Privacy">
        <SettingsRow label="Visibility" description="Who can find you" soon />
        <SettingsRow label="Available For" description="What you're open to" soon />
      </Section>

      <Section title="Public Profile">
        <ToggleRow
          label="Make Profile Public"
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
        
        {isPublic && profile && pkarrUrl && (
          <View style={s.cardContainer}>
            <PublicIdentityCard
              pkarrUrl={pkarrUrl}
              publicKeyHex={profile.publicKey}
              label="Your Public Profile"
            />
          </View>
        )}
      </Section>

      <Section title="Security">
        <SettingsRow label="Backup Seed Phrase" soon />
        <SettingsRow label="Biometric Lock" soon />
      </Section>

      <Section title="Account">
        <SettingsRow label="Export Data" soon />
        <TouchableOpacity style={s.dangerRow} disabled>
          <Text style={s.dangerLabel}>Delete Account</Text>
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

  cardContainer: {
    padding: 12,
    backgroundColor: '#0a0a0a',
  },

  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  dangerLabel: { color: '#ef4444', fontSize: 15, flex: 1 },
});

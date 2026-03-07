import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import ActionSheet, { SheetManager } from 'react-native-actions-sheet';
import type { MemberInfo } from '../ffi/gardensCore';
import { getProfile, changeMemberPermission, removeMemberFromOrg, setUserCooldown, iceMember, uniceMember, ignoreUser, unignoreUser, listIgnoredUsers } from '../ffi/gardensCore';
import { BlobImage } from '../components/BlobImage';

const ACCESS_LEVELS = ['Pull', 'Read', 'Write', 'Manage'] as const;
type AccessLevel = typeof ACCESS_LEVELS[number];

interface MemberActionsSheetProps {
  sheetId: string;
  payload?: {
    member: MemberInfo;
    orgId: string;
    onAction?: () => void;
  };
}

export function MemberActionsSheet(props: MemberActionsSheetProps) {
  const { member, orgId, onAction } = props.payload || {};
  const [profile, setProfile] = useState<{ username: string; avatarBlobId: string | null; bio: string | null } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [isIgnored, setIsIgnored] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!member) return;
    try {
      const p = await getProfile(member.publicKey);
      if (p) {
        setProfile(p);
      }
    } catch {
      // Failed to load profile
    }
  }, [member]);

  useEffect(() => {
    if (member) {
      loadProfile();
      listIgnoredUsers().then((ignored) => {
        setIsIgnored(ignored.includes(member.publicKey));
      }).catch(() => {});
    }
  }, [member, loadProfile]);

  async function handleChangePermission(level: AccessLevel) {
    if (!member || level === member.accessLevel as AccessLevel) {
      SheetManager.hide('member-actions-sheet');
      return;
    }

    setActionLoading(true);
    try {
      await changeMemberPermission(orgId!, member.publicKey, level);
      onAction?.();
      SheetManager.hide('member-actions-sheet');
    } catch {
      // Error handled by caller
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRemoveMember() {
    setActionLoading(true);
    try {
      await removeMemberFromOrg(orgId!, member!.publicKey);
      onAction?.();
      SheetManager.hide('member-actions-sheet');
    } catch {
      // Error handled by caller
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSetUserCooldown(secs: number) {
    setActionLoading(true);
    try {
      await setUserCooldown(orgId!, member!.publicKey, secs);
      onAction?.();
      SheetManager.hide('member-actions-sheet');
    } catch {
    } finally {
      setActionLoading(false);
    }
  }

  async function handleIce(secs: number) {
    setActionLoading(true);
    try {
      await iceMember(orgId!, member!.publicKey, secs);
      onAction?.();
      SheetManager.hide('member-actions-sheet');
    } catch {
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUnice() {
    setActionLoading(true);
    try {
      await uniceMember(orgId!, member!.publicKey);
      onAction?.();
      SheetManager.hide('member-actions-sheet');
    } catch {
    } finally {
      setActionLoading(false);
    }
  }

  async function handleIgnoreToggle() {
    setActionLoading(true);
    try {
      if (isIgnored) {
        await unignoreUser(member!.publicKey);
      } else {
        await ignoreUser(member!.publicKey);
      }
      setIsIgnored(!isIgnored);
      onAction?.();
      SheetManager.hide('member-actions-sheet');
    } catch {
    } finally {
      setActionLoading(false);
    }
  }

  if (!member) {
    return (
      <ActionSheet id={props.sheetId} containerStyle={styles.sheet}>
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      </ActionSheet>
    );
  }

  const displayName = profile?.username || member.publicKey.slice(0, 16) + '...';
  const initials = (profile?.username || member.publicKey).slice(0, 2).toUpperCase();

  const getBadgeStyle = (level: string) => {
    switch (level) {
      case 'Pull': return styles.badgePull;
      case 'Read': return styles.badgeRead;
      case 'Write': return styles.badgeWrite;
      case 'Manage': return styles.badgeManage;
      default: return styles.badgePull;
    }
  };

  return (
    <ActionSheet id={props.sheetId} containerStyle={styles.sheet}>
      <View style={styles.container}>
        {/* Header with member info */}
        <View style={styles.header}>
          {profile?.avatarBlobId ? (
            <BlobImage blobHash={profile.avatarBlobId} style={styles.avatar} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          )}
          <View style={styles.headerInfo}>
            <Text style={styles.name}>{displayName}</Text>
            <Text style={styles.publicKey}>{member.publicKey.slice(0, 24)}...</Text>
            {profile?.bio && (
              <Text style={styles.bio} numberOfLines={2}>{profile.bio}</Text>
            )}
          </View>
          <View style={[styles.badge, getBadgeStyle(member.accessLevel)]}>
            <Text style={styles.badgeText}>{member.accessLevel}</Text>
          </View>
        </View>

        {/* Permission Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Change Permission</Text>
          <View style={styles.levelGrid}>
            {ACCESS_LEVELS.map((level) => (
              <TouchableOpacity
                key={level}
                style={[
                  styles.levelBtn,
                  member.accessLevel === level && styles.levelBtnActive,
                ]}
                onPress={() => handleChangePermission(level)}
                disabled={actionLoading}
              >
                <Text
                  style={[
                    styles.levelBtnText,
                    member.accessLevel === level && styles.levelBtnTextActive,
                  ]}
                >
                  {level}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          
          {/* Permission Descriptions */}
          <View style={styles.permissionInfo}>
            <Text style={styles.permissionInfoTitle}>Permission Levels:</Text>
            <Text style={styles.permissionInfoItem}>• <Text style={styles.permissionBold}>Pull</Text> — Can sync data and see the org exists</Text>
            <Text style={styles.permissionInfoItem}>• <Text style={styles.permissionBold}>Read</Text> — Can read all messages and content</Text>
            <Text style={styles.permissionInfoItem}>• <Text style={styles.permissionBold}>Write</Text> — Can post messages and create rooms</Text>
            <Text style={styles.permissionInfoItem}>• <Text style={styles.permissionBold}>Manage</Text> — Can add/remove members and manage settings</Text>
            <Text style={styles.permissionNote}>Each level includes all permissions below it.</Text>
          </View>
        </View>

        {/* Danger Zone */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Cooldowns & Ice</Text>
          <View style={styles.levelGrid}>
            {[10, 30, 60].map((secs) => (
              <TouchableOpacity
                key={`cd-${secs}`}
                style={styles.levelBtn}
                onPress={() => handleSetUserCooldown(secs)}
                disabled={actionLoading}
              >
                <Text style={styles.levelBtnText}>{secs}s Slow</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.levelBtn}
              onPress={() => handleSetUserCooldown(0)}
              disabled={actionLoading}
            >
              <Text style={styles.levelBtnText}>Clear Slow</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.levelGrid, { marginTop: 8 }]}>
            {[3600, 21600, 86400].map((secs) => (
              <TouchableOpacity
                key={`ice-${secs}`}
                style={styles.levelBtn}
                onPress={() => handleIce(secs)}
                disabled={actionLoading}
              >
                <Text style={styles.levelBtnText}>
                  Ice {secs === 3600 ? '1h' : secs === 21600 ? '6h' : '24h'}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.levelBtn}
              onPress={handleUnice}
              disabled={actionLoading}
            >
              <Text style={styles.levelBtnText}>Unice</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.dangerBtn}
            onPress={handleRemoveMember}
            disabled={actionLoading}
          >
            <Text style={styles.dangerBtnText}>Remove Member</Text>
          </TouchableOpacity>
        </View>

        {/* Ignore */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Privacy</Text>
          <TouchableOpacity
            style={isIgnored ? styles.ignoreActiveBtn : styles.ignoreBtn}
            onPress={handleIgnoreToggle}
            disabled={actionLoading}
          >
            <Text style={isIgnored ? styles.ignoreActiveBtnText : styles.ignoreBtnText}>
              {isIgnored ? 'Unignore User' : 'Ignore User'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Cancel */}
        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={() => SheetManager.hide('member-actions-sheet')}
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
  center: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  avatarPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  headerInfo: {
    flex: 1,
    marginLeft: 16,
  },
  name: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  publicKey: {
    color: '#666',
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  bio: {
    color: '#888',
    fontSize: 13,
    marginTop: 4,
  },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgePull: { backgroundColor: '#374151' },
  badgeRead: { backgroundColor: '#1e40af' },
  badgeWrite: { backgroundColor: '#7c3aed' },
  badgeManage: { backgroundColor: '#dc2626' },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#555',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  levelGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  levelBtn: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  levelBtnActive: {
    borderColor: '#3b82f6',
    backgroundColor: '#1e3a8a',
  },
  levelBtnText: {
    color: '#888',
    fontSize: 14,
    fontWeight: '600',
  },
  levelBtnTextActive: {
    color: '#fff',
  },
  dangerBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  dangerBtnText: {
    color: '#ef4444',
    fontSize: 15,
    fontWeight: '600',
  },
  cancelBtn: {
    backgroundColor: '#222',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  permissionInfo: {
    marginTop: 16,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    padding: 12,
  },
  permissionInfoTitle: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  permissionInfoItem: {
    color: '#aaa',
    fontSize: 13,
    marginBottom: 6,
    lineHeight: 18,
  },
  permissionBold: {
    color: '#fff',
    fontWeight: '600',
  },
  permissionNote: {
    color: '#666',
    fontSize: 12,
    marginTop: 8,
    fontStyle: 'italic',
  },
  ignoreBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#555',
  },
  ignoreBtnText: {
    color: '#aaa',
    fontSize: 15,
    fontWeight: '600',
  },
  ignoreActiveBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  ignoreActiveBtnText: {
    color: '#3b82f6',
    fontSize: 15,
    fontWeight: '600',
  },
});

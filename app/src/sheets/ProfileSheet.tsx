import React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Image, Share, StyleSheet,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Pencil, Search, Settings, X } from 'lucide-react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { useAuthStore } from '../stores/useAuthStore';
import { useProfileStore } from '../stores/useProfileStore';
import type { MainStackParamList } from '../navigation/RootNavigator';

type Nav = NativeStackNavigationProp<MainStackParamList>;

export function ProfileSheet(props: SheetProps<'profile-sheet'>) {
  const navigation = useNavigation<Nav>();
  const { myProfile, profilePicUri, localUsername, setProfilePicUri } = useProfileStore();
  const { keypair } = useAuthStore();

  const publicKey = myProfile?.publicKey ?? keypair?.publicKeyHex ?? '';
  const username  = myProfile?.username ?? localUsername ?? 'Anonymous';
  const initials  = username.slice(0, 2).toUpperCase();

  async function handlePickImage() {
    const result = await launchImageLibrary({ mediaType: 'photo', quality: 0.8, selectionLimit: 1 });
    if (result.assets?.[0]?.uri) {
      await setProfilePicUri(result.assets[0].uri);
    }
  }

  async function handleShare() {
    try { await Share.share({ message: publicKey }); } catch {}
  }

  function close() { SheetManager.hide('profile-sheet'); }

  return (
    <ActionSheet
      id={props.sheetId}
      gestureEnabled
      containerStyle={ps.container}
      indicatorStyle={ps.handle}
    >
      {/* Header row */}
      <View style={ps.headerRow}>
        <TouchableOpacity style={ps.headerBtn} onPress={close}>
          <X size={18} color="#888" />
        </TouchableOpacity>
        <Text style={ps.headerTitle}>Profile</Text>
        <TouchableOpacity
          style={ps.headerBtn}
          onPress={() => { close(); navigation.navigate('Settings'); }}
        >
          <Pencil size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Avatar */}
        <View style={ps.avatarWrap}>
          <TouchableOpacity onPress={handlePickImage}>
            {profilePicUri ? (
              <Image source={{ uri: profilePicUri }} style={ps.avatarLarge} />
            ) : (
              <View style={[ps.avatarLarge, ps.avatarPlaceholder]}>
                <Text style={ps.avatarInitials}>{initials}</Text>
              </View>
            )}
            <View style={ps.addDot}>
              <Text style={ps.addDotText}>+</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text style={ps.username}>{username}</Text>

        <View style={ps.keySection}>
          <View style={ps.keyLabelRow}>
            <View style={ps.keyLabelPill}>
              <Text style={ps.keyLabelText}>Public Key</Text>
            </View>
          </View>
          <Text style={ps.keyText} selectable>{publicKey}</Text>
        </View>

        <TouchableOpacity style={ps.shareBtn} onPress={handleShare}>
          <Text style={ps.shareBtnText}>Share</Text>
        </TouchableOpacity>

        <View style={ps.menuSection}>
          <TouchableOpacity
            style={ps.menuItem}
            onPress={() => { close(); navigation.navigate('DiscoverOrgs'); }}
          >
            <Search size={20} color="#fff" />
            <Text style={ps.menuItemText}>Discover Communities</Text>
          </TouchableOpacity>
          <View style={ps.menuDivider} />
          <TouchableOpacity
            style={ps.menuItem}
            onPress={() => { close(); navigation.navigate('Settings'); }}
          >
            <Settings size={20} color="#fff" />
            <Text style={ps.menuItemText}>Settings</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </ActionSheet>
  );
}

const ps = StyleSheet.create({
  container:      { backgroundColor: '#111', paddingHorizontal: 20, paddingBottom: 40, maxHeight: '92%' },
  handle:         { backgroundColor: '#333' },
  headerRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  headerTitle:    { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerBtn:      { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  avatarWrap:     { alignItems: 'center', marginTop: 12, marginBottom: 16 },
  avatarLarge:    { width: 96, height: 96, borderRadius: 48 },
  avatarPlaceholder: { backgroundColor: '#7c3aed', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { color: '#fff', fontSize: 36, fontWeight: '700' },
  addDot:         { position: 'absolute', bottom: 2, right: 2, width: 26, height: 26, borderRadius: 13, backgroundColor: '#22c55e', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#111' },
  addDotText:     { color: '#000', fontSize: 16, fontWeight: '700', lineHeight: 20 },
  username:       { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 20 },
  keySection:     { marginBottom: 20 },
  keyLabelRow:    { alignItems: 'center', marginBottom: 12 },
  keyLabelPill:   { borderWidth: 1, borderColor: '#333', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 4 },
  keyLabelText:   { color: '#888', fontSize: 13 },
  keyText:        { color: '#fff', fontSize: 14, textAlign: 'center', lineHeight: 22, letterSpacing: 0.5 },
  shareBtn:       { borderWidth: 1, borderColor: '#22c55e', borderRadius: 24, paddingVertical: 12, alignItems: 'center', marginBottom: 24 },
  shareBtnText:   { color: '#22c55e', fontWeight: '700', fontSize: 15 },
  menuSection:    { backgroundColor: '#1a1a1a', borderRadius: 14, overflow: 'hidden', marginBottom: 16 },
  menuItem:       { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 16 },
  menuItemText:   { color: '#fff', fontSize: 15, fontWeight: '500' },
  menuDivider:    { height: 1, backgroundColor: '#2a2a2a', marginLeft: 50 },
});

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Image, TextInput,
  ActivityIndicator, StyleSheet, Share,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ChevronRight } from 'lucide-react-native';
import { useOrgsStore } from '../stores/useOrgsStore';
import { useDMStore } from '../stores/useDMStore';
import { useProfileStore } from '../stores/useProfileStore';
import { useAuthStore } from '../stores/useAuthStore';
import type { MainStackParamList } from '../navigation/RootNavigator';

type Nav = NativeStackNavigationProp<MainStackParamList>;
type Mode = 'menu' | 'createOrg' | 'newDm';

export function FabSheet(props: SheetProps<'fab-sheet'>) {
  const navigation = useNavigation<Nav>();
  const { createOrg, fetchMyOrgs } = useOrgsStore();
  const { createThread } = useDMStore();
  const { myProfile } = useProfileStore();
  const { keypair } = useAuthStore();

  const [mode, setMode] = useState<Mode>('menu');
  const [orgName, setOrgName] = useState('');
  const [dmKey, setDmKey] = useState('');
  const [busy, setBusy] = useState(false);

  const publicKey = myProfile?.publicKey ?? keypair?.publicKeyHex ?? '';
  const qrValue = `delta://invite?pubkey=${encodeURIComponent(publicKey)}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrValue)}`;

  function close() { SheetManager.hide('fab-sheet'); }

  function reset() {
    setMode('menu');
    setOrgName('');
    setDmKey('');
    setBusy(false);
  }

  async function handleCreateOrg() {
    if (!orgName.trim()) return;
    setBusy(true);
    try {
      const orgId = await createOrg(orgName.trim(), 'Group', null, false);
      await fetchMyOrgs();
      close();
      navigation.navigate('OrgChat', { orgId, orgName: orgName.trim() });
    } finally {
      setBusy(false);
    }
  }

  async function handleNewDM() {
    if (!dmKey.trim()) return;
    setBusy(true);
    try {
      const threadId = await createThread(dmKey.trim());
      close();
      navigation.navigate('DMChat', { threadId, recipientKey: dmKey.trim() });
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite() {
    try { await Share.share({ message: publicKey }); } catch {}
  }

  return (
    <ActionSheet
      id={props.sheetId}
      gestureEnabled={!busy}
      containerStyle={fs.container}
      indicatorStyle={fs.handle}
      onBeforeShow={reset}
    >
      {mode === 'menu' && (
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={fs.title}>New</Text>

          <TouchableOpacity style={fs.row} onPress={() => setMode('newDm')}>
            <View style={fs.iconCircle}><Text style={fs.iconChar}>DM</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={fs.rowTitle}>New direct message</Text>
              <Text style={fs.rowSub}>Chat with someone privately</Text>
            </View>
            <ChevronRight size={16} color="#555" />
          </TouchableOpacity>

          <TouchableOpacity style={fs.row} onPress={() => setMode('createOrg')}>
            <View style={fs.iconCircle}><Text style={fs.iconChar}>O</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={fs.rowTitle}>Create organization</Text>
              <Text style={fs.rowSub}>Start a new community</Text>
            </View>
            <ChevronRight size={16} color="#555" />
          </TouchableOpacity>

          <TouchableOpacity
            style={fs.row}
            onPress={() => { close(); navigation.navigate('DiscoverOrgs'); }}
          >
            <View style={fs.iconCircle}><Text style={fs.iconChar}>D</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={fs.rowTitle}>Discover communities</Text>
              <Text style={fs.rowSub}>Find public organizations</Text>
            </View>
            <ChevronRight size={16} color="#555" />
          </TouchableOpacity>

          <TouchableOpacity style={fs.row} onPress={handleInvite}>
            <View style={fs.iconCircle}><Text style={fs.iconChar}>+</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={fs.rowTitle}>Invite a friend</Text>
              <Text style={fs.rowSub}>Share your public key</Text>
            </View>
            <ChevronRight size={16} color="#555" />
          </TouchableOpacity>

          {publicKey ? (
            <View style={fs.qrSection}>
              <Text style={fs.qrTitle}>Your Public Key</Text>
              <Text style={fs.qrSub}>Friends can message you by scanning your QR code.</Text>
              <View style={fs.qrWrap}>
                <Image source={{ uri: qrUrl }} style={fs.qrImage} />
              </View>
            </View>
          ) : null}
        </ScrollView>
      )}

      {mode === 'createOrg' && (
        <>
          <Text style={fs.title}>Create organization</Text>
          <TextInput
            value={orgName}
            onChangeText={setOrgName}
            placeholder="Organization name"
            placeholderTextColor="#666"
            style={fs.input}
            editable={!busy}
          />
          <View style={fs.actionsRow}>
            <TouchableOpacity style={fs.secondaryBtn} onPress={() => setMode('menu')} disabled={busy}>
              <Text style={fs.secondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={fs.primaryBtn} onPress={handleCreateOrg} disabled={busy || !orgName.trim()}>
              {busy ? <ActivityIndicator color="#000" /> : <Text style={fs.primaryText}>Create</Text>}
            </TouchableOpacity>
          </View>
        </>
      )}

      {mode === 'newDm' && (
        <>
          <Text style={fs.title}>New direct message</Text>
          <TextInput
            value={dmKey}
            onChangeText={setDmKey}
            placeholder="Recipient public key"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            style={fs.input}
            editable={!busy}
          />
          <View style={fs.actionsRow}>
            <TouchableOpacity style={fs.secondaryBtn} onPress={() => setMode('menu')} disabled={busy}>
              <Text style={fs.secondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={fs.primaryBtn} onPress={handleNewDM} disabled={busy || !dmKey.trim()}>
              {busy ? <ActivityIndicator color="#000" /> : <Text style={fs.primaryText}>Start</Text>}
            </TouchableOpacity>
          </View>
        </>
      )}
    </ActionSheet>
  );
}

const fs = StyleSheet.create({
  container:    { backgroundColor: '#111', padding: 16, maxHeight: '92%' },
  handle:       { backgroundColor: '#333' },
  title:        { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 8 },
  row:          { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  iconCircle:   { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1f2937', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  iconChar:     { color: '#fff', fontWeight: '700' },
  rowTitle:     { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowSub:       { color: '#888', fontSize: 12 },
  qrSection:    { marginTop: 8, paddingBottom: 24 },
  qrTitle:      { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 4 },
  qrSub:        { color: '#888', fontSize: 13, marginBottom: 16 },
  qrWrap:       { backgroundColor: '#fff', borderRadius: 16, padding: 16, alignItems: 'center' },
  qrImage:      { width: 248, height: 248 },
  input:        { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#222', marginTop: 8 },
  actionsRow:   { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 12 },
  primaryBtn:   { backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  primaryText:  { color: '#000', fontWeight: '700' },
  secondaryBtn: { backgroundColor: '#222', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  secondaryText:{ color: '#fff' },
});

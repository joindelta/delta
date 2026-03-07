import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import ActionSheet, { SheetProps } from 'react-native-actions-sheet';
import { SheetManager } from 'react-native-actions-sheet';
import { useInboxStore } from '../stores/useInboxStore';
import { useAuthStore } from '../stores/useAuthStore';

const RELAY_DOMAIN = 'gardens-relay.stereos.workers.dev';

type ComposePayload = {
  to?: string;
  subject?: string;
  replyToMessageId?: string;
};

export function ComposeEmailSheet({ sheetId, payload }: SheetProps<'compose-email-sheet'>) {
  const p = (payload ?? {}) as ComposePayload;
  const [to, setTo] = useState(p.to ?? '');
  const [subject, setSubject] = useState(p.subject ?? '');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const { sendEmail } = useInboxStore();
  const { keypair } = useAuthStore();

  const fromDisplay = keypair?.publicKeyHex
    ? `${keypair.publicKeyHex.slice(0, 20)}...@${RELAY_DOMAIN}`
    : `...@${RELAY_DOMAIN}`;

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      Alert.alert('Missing fields', 'Please fill in To, Subject, and Body.');
      return;
    }
    setSending(true);
    try {
      await sendEmail({
        to: to.trim(),
        subject: subject.trim(),
        bodyText: body.trim(),
        replyToMessageId: p.replyToMessageId,
      });
      SheetManager.hide(sheetId);
    } catch (e: unknown) {
      Alert.alert('Send failed', e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <ActionSheet id={sheetId} gestureEnabled>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>New Email</Text>
          <TouchableOpacity onPress={handleSend} disabled={sending} style={styles.sendBtn}>
            {sending
              ? <ActivityIndicator color="#000" size="small" />
              : <Text style={styles.sendText}>Send</Text>
            }
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>From</Text>
        <Text style={styles.fromAddr}>{fromDisplay}</Text>

        <Text style={styles.label}>To</Text>
        <TextInput
          style={styles.input}
          value={to}
          onChangeText={setTo}
          placeholder="recipient@example.com"
          placeholderTextColor="#555"
          autoCapitalize="none"
          keyboardType="email-address"
        />

        <Text style={styles.label}>Subject</Text>
        <TextInput
          style={styles.input}
          value={subject}
          onChangeText={setSubject}
          placeholder="Subject"
          placeholderTextColor="#555"
        />

        <TextInput
          style={styles.body}
          value={body}
          onChangeText={setBody}
          placeholder="Write your message..."
          placeholderTextColor="#555"
          multiline
          textAlignVertical="top"
        />
      </View>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#111', borderRadius: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  sendBtn: { backgroundColor: '#F2E58F', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  sendText: { color: '#000', fontWeight: '700' },
  label: { color: '#666', fontSize: 12, marginTop: 12, marginBottom: 4 },
  fromAddr: { color: '#888', fontSize: 13, marginBottom: 8 },
  input: { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, padding: 12, fontSize: 15 },
  body: { backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, padding: 12, fontSize: 15, minHeight: 160, marginTop: 16 },
});

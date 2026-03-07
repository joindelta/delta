import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import ActionSheet, { SheetProps } from 'react-native-actions-sheet';
import { SheetManager } from 'react-native-actions-sheet';
import type { InboxEmail } from '../stores/useInboxStore';

export function EmailDetailSheet({ sheetId, payload }: SheetProps<'email-detail-sheet'>) {
  const email = payload as InboxEmail | undefined;
  if (!email) return null;

  const handleReply = () => {
    SheetManager.hide(sheetId);
    SheetManager.show('compose-email-sheet', {
      payload: {
        to: email.from,
        subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
        replyToMessageId: email.messageId,
      },
    });
  };

  return (
    <ActionSheet id={sheetId} gestureEnabled containerStyle={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.subject} numberOfLines={2}>{email.subject}</Text>
        <Text style={styles.from}>{email.from}</Text>
        <Text style={styles.date}>{new Date(email.receivedAt).toLocaleString()}</Text>
      </View>
      <ScrollView style={styles.body}>
        <Text style={styles.bodyText}>{email.bodyText}</Text>
      </ScrollView>
      <View style={styles.actions}>
        <TouchableOpacity style={styles.replyBtn} onPress={handleReply}>
          <Text style={styles.replyText}>Reply</Text>
        </TouchableOpacity>
      </View>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: '#111', borderRadius: 16 },
  header: { padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  subject: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  from: { color: '#aaa', fontSize: 14 },
  date: { color: '#555', fontSize: 12, marginTop: 4 },
  body: { maxHeight: 400 },
  bodyText: { color: '#ddd', fontSize: 15, lineHeight: 22, padding: 20 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', padding: 16 },
  replyBtn: { backgroundColor: '#F2E58F', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  replyText: { color: '#000', fontWeight: '700' },
});

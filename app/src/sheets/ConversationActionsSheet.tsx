import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import ActionSheet, { SheetManager } from 'react-native-actions-sheet';

interface ConversationActionsSheetProps {
  sheetId: string;
  payload?: {
    title?: string;
    onDelete?: () => void;
  };
}

export function ConversationActionsSheet(props: ConversationActionsSheetProps) {
  const { title, onDelete } = props.payload || {};

  return (
    <ActionSheet id={props.sheetId} containerStyle={styles.sheet}>
      <View style={styles.container}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <TouchableOpacity
          style={styles.row}
          onPress={() => {
            SheetManager.hide(props.sheetId);
            onDelete?.();
          }}
        >
          <Text style={styles.rowTextDanger}>Delete conversation</Text>
        </TouchableOpacity>
      </View>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  container: { paddingVertical: 8 },
  title: { color: '#9ca3af', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 18, paddingBottom: 6 },
  row: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  rowTextDanger: { color: '#ef4444', fontSize: 15, fontWeight: '600' },
});

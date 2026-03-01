import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';

export function AttachSheet(props: SheetProps<'attach-sheet'>) {
  return (
    <ActionSheet id={props.sheetId} gestureEnabled containerStyle={styles.container}>
      <TouchableOpacity
        style={styles.option}
        onPress={() => SheetManager.hide('attach-sheet', { returnValue: 'media' })}
      >
        <Text style={styles.optionText}>Photo / Video</Text>
      </TouchableOpacity>
      <View style={styles.divider} />
      <TouchableOpacity
        style={styles.option}
        onPress={() => SheetManager.hide('attach-sheet', { returnValue: 'gif' })}
      >
        <Text style={styles.optionText}>GIF</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.option, styles.cancelOption]}
        onPress={() => SheetManager.hide('attach-sheet')}
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  container:    { backgroundColor: '#111', paddingBottom: 8 },
  option:       { paddingVertical: 18, paddingHorizontal: 24, alignItems: 'center' },
  optionText:   { color: '#fff', fontSize: 17 },
  divider:      { height: 1, backgroundColor: '#1f1f1f', marginHorizontal: 24 },
  cancelOption: { marginTop: 8, borderTopWidth: 1, borderTopColor: '#1f1f1f' },
  cancelText:   { color: '#888', fontSize: 17 },
});

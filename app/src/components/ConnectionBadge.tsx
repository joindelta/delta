import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useNetworkStore } from '../stores/useNetworkStore';
import type { ConnectionStatus } from '../ffi/deltaCore';

const COLORS: Record<ConnectionStatus, string> = {
  Online:     '#22c55e',
  Connecting: '#f59e0b',
  Offline:    '#6b7280',
};

const LABELS: Record<ConnectionStatus, string> = {
  Online:     'Online',
  Connecting: 'Connecting',
  Offline:    'Offline',
};

export function ConnectionBadge() {
  const { status, startPolling, stopPolling } = useNetworkStore();

  useEffect(() => {
    startPolling();
    return stopPolling;
  }, [startPolling, stopPolling]);

  const color = COLORS[status];

  return (
    <View style={styles.row}>
      {status === 'Connecting' ? (
        <ActivityIndicator size={10} color={color} style={styles.dot} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <Text style={[styles.label, { color }]}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  dot:   { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  label: { fontSize: 12, fontWeight: '500' },
});

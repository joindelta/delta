import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useAuthStore } from '../stores/useAuthStore';

export function LockScreen() {
  const { unlockWithBiometric, isUnlocked } = useAuthStore();
  const isPrompting = isUnlocked === null;

  return (
    <View style={s.root}>
      <Text style={s.title}>Gardens</Text>
      <Text style={s.subtitle}>Your session has been locked</Text>
      {isPrompting ? (
        <ActivityIndicator color="#fff" style={s.btn} />
      ) : (
        <TouchableOpacity style={s.btn} onPress={unlockWithBiometric}>
          <Text style={s.btnText}>Unlock</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a0a0a',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#555', fontSize: 15, marginBottom: 48 },
  btn: {
    backgroundColor: '#F2E58F',
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
  },
  btnText: { color: '#000', fontWeight: '700', fontSize: 16 },
});

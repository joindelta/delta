import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<AuthStackParamList, 'Welcome'>;

export function WelcomeScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.hero}>
        <Text style={styles.logo}>Delta</Text>
        <Text style={styles.tagline}>Private, local-first messaging</Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, styles.btnPrimary]}
          onPress={() => navigation.navigate('Signup')}
        >
          <Text style={[styles.btnText, styles.btnTextPrimary]}>
            Create Account
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary]}
          onPress={() => navigation.navigate('SeedRecovery')}
        >
          <Text style={[styles.btnText, styles.btnTextSecondary]}>
            Import 24-word Seed
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logo: {
    fontSize: 56,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -2,
  },
  tagline: {
    marginTop: 12,
    fontSize: 17,
    color: '#888888',
    textAlign: 'center',
  },
  actions: {
    paddingHorizontal: 24,
    paddingBottom: 48,
    gap: 12,
  },
  btn: {
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#ffffff',
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#333333',
  },
  btnText: {
    fontSize: 16,
    fontWeight: '600',
  },
  btnTextPrimary: {
    color: '#0a0a0a',
  },
  btnTextSecondary: {
    color: '#ffffff',
  },
});

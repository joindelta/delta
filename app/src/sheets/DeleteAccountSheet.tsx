import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { X, AlertTriangle, Trash2 } from 'lucide-react-native';
import { useAuthStore } from '../stores/useAuthStore';
import { useProfileStore } from '../stores/useProfileStore';
import * as Keychain from 'react-native-keychain';

const KEYCHAIN_SERVICE = 'gardens.privateKey';
const PUBKEY_SERVICE = 'gardens.publicKey';
const MNEMONIC_SERVICE = 'gardens.mnemonic';

export function DeleteAccountSheet(props: SheetProps<'delete-account-sheet'>) {
  const { lock } = useAuthStore();
  const { myProfile, localUsername } = useProfileStore();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [step, setStep] = useState(1);

  const username = myProfile?.username || localUsername || 'your account';
  const expectedConfirm = `delete ${username}`;

  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    }
  };

  const handleDelete = async () => {
    if (confirmText.toLowerCase() !== expectedConfirm.toLowerCase()) {
      Alert.alert('Error', 'Confirmation text does not match');
      return;
    }

    setDeleting(true);
    try {
      // Clear all keychain data
      await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
      await Keychain.resetGenericPassword({ service: PUBKEY_SERVICE });
      await Keychain.resetGenericPassword({ service: MNEMONIC_SERVICE });
      
      // Lock the session
      lock();

      Alert.alert(
        'Account Deleted',
        'Your account has been deleted. You will need to create a new account to use Gardens again.',
        [
          {
            text: 'OK',
            onPress: () => {
              SheetManager.hide('delete-account-sheet');
            },
          },
        ]
      );
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  };

  function close() {
    SheetManager.hide('delete-account-sheet');
  }

  return (
    <ActionSheet
      id={props.sheetId}
      gestureEnabled
      containerStyle={s.container}
      indicatorStyle={s.handle}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={close} style={s.headerBtn}>
          <X size={20} color="#888" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Delete Account</Text>
        <View style={s.headerSpacer} />
      </View>

      <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
        {step === 1 ? (
          <>
            {/* Warning icon */}
            <View style={s.warningIcon}>
              <AlertTriangle size={48} color="#ef4444" />
            </View>

            <Text style={s.title}>Are you sure?</Text>
            <Text style={s.description}>
              This action cannot be undone. This will permanently delete your account and remove all your data from this device.
            </Text>

            {/* What will be deleted */}
            <View style={s.deletedSection}>
              <Text style={s.deletedTitle}>This will delete:</Text>
              <View style={s.deletedItem}>
                <Trash2 size={14} color="#ef4444" />
                <Text style={s.deletedText}>Your profile and settings</Text>
              </View>
              <View style={s.deletedItem}>
                <Trash2 size={14} color="#ef4444" />
                <Text style={s.deletedText}>Your private key and seed phrase</Text>
              </View>
              <View style={s.deletedItem}>
                <Trash2 size={14} color="#ef4444" />
                <Text style={s.deletedText}>Local message history</Text>
              </View>
              <View style={s.deletedItem}>
                <Trash2 size={14} color="#ef4444" />
                <Text style={s.deletedText}>Your membership in organizations</Text>
              </View>
            </View>

            {/* Note about distributed data */}
            <View style={s.noteBox}>
              <Text style={s.noteText}>
                Note: Data you've shared with others (messages, organization content) may still exist on their devices or in distributed storage.
              </Text>
            </View>

            {/* Next button */}
            <TouchableOpacity style={s.nextBtn} onPress={handleNext}>
              <Text style={s.nextBtnText}>I understand, continue</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {/* Confirmation step */}
            <Text style={s.confirmTitle}>Final Confirmation</Text>
            <Text style={s.confirmDesc}>
              To confirm deletion, please type:
            </Text>
            <Text style={s.confirmCode}>{expectedConfirm}</Text>

            <TextInput
              style={s.confirmInput}
              value={confirmText}
              onChangeText={setConfirmText}
              placeholder="Type the confirmation text"
              placeholderTextColor="#555"
              autoCapitalize="none"
              autoCorrect={false}
            />

            {/* Delete button */}
            <TouchableOpacity 
              style={[s.deleteBtn, deleting && s.deleteBtnDisabled]} 
              onPress={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Trash2 size={18} color="#fff" />
                  <Text style={s.deleteBtnText}>Permanently Delete Account</Text>
                </>
              )}
            </TouchableOpacity>

            {/* Back button */}
            <TouchableOpacity 
              style={s.backBtn} 
              onPress={() => setStep(1)}
              disabled={deleting}
            >
              <Text style={s.backBtnText}>Go Back</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </ActionSheet>
  );
}

const s = StyleSheet.create({
  container: { 
    backgroundColor: '#111', 
    paddingHorizontal: 20, 
    paddingBottom: 40,
    minHeight: 450,
  },
  handle: { backgroundColor: '#333' },
  center: { paddingVertical: 40, alignItems: 'center' },
  
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  headerBtn: { padding: 4 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 28 },
  
  content: { marginTop: 20 },
  
  warningIcon: {
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    color: '#ef4444',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  description: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  
  deletedSection: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  deletedTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  deletedItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  deletedText: {
    color: '#888',
    fontSize: 13,
  },
  
  noteBox: {
    backgroundColor: '#451a03',
    borderRadius: 12,
    padding: 14,
    marginBottom: 24,
  },
  noteText: {
    color: '#fbbf24',
    fontSize: 12,
    lineHeight: 18,
  },
  
  nextBtn: {
    backgroundColor: '#dc2626',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  nextBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  
  confirmTitle: {
    color: '#ef4444',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  confirmDesc: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  confirmCode: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: '#1a1a1a',
    padding: 12,
    borderRadius: 8,
    marginBottom: 20,
    fontFamily: 'monospace',
  },
  confirmInput: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    color: '#fff',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#ef4444',
    marginBottom: 20,
  },
  
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#dc2626',
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  deleteBtnDisabled: {
    opacity: 0.5,
  },
  deleteBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  backBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  backBtnText: {
    color: '#888',
    fontSize: 14,
  },
});

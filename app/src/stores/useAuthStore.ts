/**
 * Auth store — owns keypair lifecycle and biometric unlock state.
 *
 * Storage contract
 * ----------------
 * - Private key seed: stored in iOS Keychain / Android Keystore under the
 *   service key `delta.privateKey`, protected by biometric authentication.
 * - Public key + mnemonic: stored under `delta.publicKey` / `delta.mnemonic`
 *   without biometric guard (they are not secrets).
 */

import { create } from 'zustand';
import * as Keychain from 'react-native-keychain';
import { generateKeypair, importFromMnemonic, initCore, type KeyPair } from '../ffi/deltaCore';

const KEYCHAIN_SERVICE = 'delta.privateKey';
const PUBKEY_SERVICE   = 'delta.publicKey';
const MNEMONIC_SERVICE = 'delta.mnemonic';

interface AuthState {
  keypair: KeyPair | null;
  isUnlocked: boolean | null;

  /** Generate a new keypair, persist to Keychain, mark unlocked. */
  createAccount(): Promise<KeyPair>;

  /** Re-derive from 24 words, persist, mark unlocked. */
  importAccount(words: string[]): Promise<KeyPair>;

  /**
   * Show biometric prompt. If the user passes, load key from Keychain and
   * mark unlocked.  Returns false if biometric fails or no key stored.
   */
  unlockWithBiometric(): Promise<boolean>;

  /** Lock the session (keypair stays in Keychain; clears in-memory copy). */
  lock(): void;
}

async function persistKeypair(kp: KeyPair): Promise<void> {
  await Keychain.setGenericPassword('key', kp.privateKeyHex, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  });
  await Keychain.setGenericPassword('key', kp.publicKeyHex, {
    service: PUBKEY_SERVICE,
  });
  await Keychain.setGenericPassword('key', kp.mnemonic, {
    service: MNEMONIC_SERVICE,
  });
}

export const useAuthStore = create<AuthState>((set) => ({
  keypair: null,
  isUnlocked: null,

  async createAccount() {
    const kp = await generateKeypair();
    await persistKeypair(kp);
    await initCore(kp.privateKeyHex);
    set({ keypair: kp, isUnlocked: true });
    return kp;
  },

  async importAccount(words: string[]) {
    const kp = await importFromMnemonic(words);
    await persistKeypair(kp);
    await initCore(kp.privateKeyHex);
    set({ keypair: kp, isUnlocked: true });
    return kp;
  },

  async unlockWithBiometric() {
    try {
      const result = await Keychain.getGenericPassword({
        service: KEYCHAIN_SERVICE,
        authenticationPrompt: {
          title: 'Unlock Delta',
          subtitle: 'Confirm your identity to continue',
        },
      });
      if (!result) {
        set({ isUnlocked: false });
        return false;
      }

      const pubResult = await Keychain.getGenericPassword({ service: PUBKEY_SERVICE });
      const mnResult  = await Keychain.getGenericPassword({ service: MNEMONIC_SERVICE });

      const kp: KeyPair = {
        privateKeyHex: result.password,
        publicKeyHex:  pubResult ? pubResult.password : '',
        mnemonic:      mnResult  ? mnResult.password  : '',
      };
      await initCore(kp.privateKeyHex);
      set({ keypair: kp, isUnlocked: true });
      return true;
    } catch {
      set({ isUnlocked: false });
      return false;
    }
  },

  lock() {
    set({ keypair: null, isUnlocked: false });
  },
}));

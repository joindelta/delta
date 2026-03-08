# Biometric Auto-Lock Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Lock the app after 30 seconds in the background and require biometric re-authentication, always-on with no user toggle.

**Architecture:** Add `hasStoredKey` to `useAuthStore` (persisted via AsyncStorage) so we can distinguish "locked session" from "no account". Add an AppState listener in `RootNavigator` that starts a 30s timer on background and triggers `unlockWithBiometric()` on foreground if locked. Render a full-screen `LockScreen` overlay (outside the navigator) when `isUnlocked === false && hasStoredKey === true`. Remove the "Biometric Lock" row from UserSettings.

**Tech Stack:** React Native `AppState`, `AsyncStorage` (@react-native-async-storage/async-storage), `react-native-keychain`, Zustand

---

### Task 1: Add `hasStoredKey` to `useAuthStore`

**Files:**
- Modify: `src/stores/useAuthStore.ts`

**Step 1: Add the flag and `checkHasStoredKey` to the interface**

In `useAuthStore.ts`, add to `AuthState`:

```ts
hasStoredKey: boolean;

/**
 * Reads AsyncStorage to determine if an account exists without
 * triggering a biometric prompt. Call once on app start.
 */
checkHasStoredKey(): Promise<void>;
```

**Step 2: Add the import and constant**

At the top of `useAuthStore.ts`, add:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

const HAS_ACCOUNT_KEY = 'gardens.hasAccount';
```

**Step 3: Implement `checkHasStoredKey` and update `createAccount`/`importAccount`**

In the Zustand store body:

```ts
hasStoredKey: false,

async checkHasStoredKey() {
  const val = await AsyncStorage.getItem(HAS_ACCOUNT_KEY);
  set({ hasStoredKey: val === 'true' });
},

async createAccount() {
  const kp = await generateKeypair();
  await persistKeypair(kp);
  await initCore(kp.privateKeyHex);
  await initNetwork(null);
  await AsyncStorage.setItem(HAS_ACCOUNT_KEY, 'true');
  set({ keypair: kp, isUnlocked: true, hasStoredKey: true });
  return kp;
},

async importAccount(words: string[]) {
  const kp = await importFromMnemonic(words);
  await persistKeypair(kp);
  await initCore(kp.privateKeyHex);
  await initNetwork(null);
  await AsyncStorage.setItem(HAS_ACCOUNT_KEY, 'true');
  set({ keypair: kp, isUnlocked: true, hasStoredKey: true });
  return kp;
},
```

Leave `unlockWithBiometric` and `lock` unchanged.

**Step 4: Commit**

```bash
git add src/stores/useAuthStore.ts
git commit -m "feat(auth): add hasStoredKey flag to distinguish locked vs no-account"
```

---

### Task 2: Create the `LockScreen` component

**Files:**
- Create: `src/components/LockScreen.tsx`

**Step 1: Write the component**

```tsx
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
```

**Step 2: Commit**

```bash
git add src/components/LockScreen.tsx
git commit -m "feat(auth): add LockScreen overlay component"
```

---

### Task 3: Add AppState listener + lock screen routing to `RootNavigator`

**Files:**
- Modify: `src/navigation/RootNavigator.tsx`

**Step 1: Add imports**

Add to the existing imports in `RootNavigator.tsx`:

```ts
import { AppState, type AppStateStatus } from 'react-native';
import { LockScreen } from '../components/LockScreen';
```

**Step 2: Call `checkHasStoredKey` on mount in `RootNavigator`**

Replace the existing `RootNavigator` function:

```tsx
export function RootNavigator() {
  const { isUnlocked, hasStoredKey, unlockWithBiometric, lock, checkHasStoredKey } = useAuthStore();
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Check for stored account first, then attempt biometric unlock
    checkHasStoredKey().then(() => unlockWithBiometric());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 30-second background auto-lock
  useEffect(() => {
    function handleAppStateChange(nextState: AppStateStatus) {
      if (nextState === 'background' || nextState === 'inactive') {
        lockTimer.current = setTimeout(() => {
          lock();
        }, 30_000);
      } else if (nextState === 'active') {
        if (lockTimer.current) {
          clearTimeout(lockTimer.current);
          lockTimer.current = null;
        }
        // Re-prompt biometrics if we came back locked with an account
        const { isUnlocked: currentLocked, hasStoredKey: currentHasKey } = useAuthStore.getState();
        if (!currentLocked && currentHasKey) {
          unlockWithBiometric();
        }
      }
    }

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      sub.remove();
      if (lockTimer.current) clearTimeout(lockTimer.current);
    };
  }, [lock, unlockWithBiometric]);

  // Splash while we haven't determined state yet
  if (isUnlocked === null) {
    return (
      <View style={splash.root}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  // Has account but locked — show lock screen overlay
  if (!isUnlocked && hasStoredKey) {
    return <LockScreen />;
  }

  // No account — show auth flow
  if (!isUnlocked) {
    return <AuthNavigator />;
  }

  // Unlocked — show main app
  return <MainNavigator />;
}
```

Note: `useRef` is already imported from React. Add `useRef` to the existing `import React, { useEffect, ... }` line if it's not there.

**Step 3: Verify `useRef` is in the React import**

The existing import is:
```ts
import React, { useEffect, useRef, useState } from 'react';
```
`useRef` is already imported — no change needed.

**Step 4: Commit**

```bash
git add src/navigation/RootNavigator.tsx
git commit -m "feat(auth): add 30s background auto-lock with AppState listener"
```

---

### Task 4: Remove the "Biometric Lock" row from UserSettingsScreen

**Files:**
- Modify: `src/screens/UserSettingsScreen.tsx`

**Step 1: Remove the static row**

Find and delete this block in the `Security` section:

```tsx
<SettingsRow
  label="Biometric Lock"
  description="Require biometric authentication"
  value="Enabled"
/>
```

The Security section should now only contain the "Backup Seed Phrase" row.

**Step 2: Commit**

```bash
git add src/screens/UserSettingsScreen.tsx
git commit -m "feat(auth): remove biometric lock toggle — always-on auto-lock"
```

---

### Task 5: Manual smoke test checklist

1. Cold start with no account → Welcome screen shows
2. Create account → lands in main app
3. Background app for < 30s, return → no biometric prompt (still unlocked)
4. Background app for > 30s, return → LockScreen appears, tap "Unlock" → biometric prompt → unlocks into app
5. Kill and restart app → biometric prompt on cold start (existing behavior preserved)
6. Open UserSettings → no "Biometric Lock" row in Security section

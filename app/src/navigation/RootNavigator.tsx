/**
 * RootNavigator
 *
 * Layout: Single stack with a floating circular + button that opens a bottom
 * sheet for primary actions. Header avatar opens a profile sheet. Bottom tab
 * bar removed.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Image,
  Linking,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetManager } from 'react-native-actions-sheet';
import { Settings, Plus } from 'lucide-react-native';
import { useAuthStore } from '../stores/useAuthStore';
import { useProfileStore } from '../stores/useProfileStore';
import { registerPushToken, setupForegroundHandler } from '../services/pushNotifications';

import { WelcomeScreen } from '../screens/WelcomeScreen';
import { SignupScreen } from '../screens/SignupScreen';
import { SeedRecoveryScreen } from '../screens/SeedRecoveryScreen';
import { DiscoverOrgsScreen } from '../screens/DiscoverOrgsScreen';
import { InviteScreen } from '../screens/InviteScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { InboxScreen } from '../screens/InboxScreen';
import { OrgChatScreen } from '../screens/OrgChatScreen';
import { OrgSettingsScreen } from '../screens/OrgSettingsScreen';
import { UserSettingsScreen } from '../screens/UserSettingsScreen';
import { ConversationScreen } from '../screens/ConversationScreen';
import { RequestsScreen } from '../screens/RequestsScreen';
import { MemberListScreen } from '../screens/MemberListScreen';
import { AddMemberScreen } from '../screens/AddMemberScreen';
import { JoinOrgScreen } from '../screens/JoinOrgScreen';
import { DebugConnectionPanel } from '../components/DebugConnectionPanel';
import { LockScreen } from '../components/LockScreen';

// Import the Gardens logo for the FAB
// const gardensLogo = require('../../assets/gardens-logo.png');

// ─── Param lists ──────────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Welcome: undefined;
  Signup: undefined;
  SeedRecovery: undefined;
};

export type MainStackParamList = {
  Home: undefined;
  Inbox: undefined;
  Requests: undefined;
  DiscoverOrgs: undefined;
  Invite: { orgId: string; orgName: string };
  OrgChat: { orgId: string; orgName: string };
  OrgSettings: { orgId: string; orgName: string };
  MemberList: { orgId: string; orgName: string };
  AddMember: { orgId: string; orgName: string };
  JoinOrg: { token: string };
  Conversation: { threadId: string; recipientKey: string };
  Profile: undefined;
  Settings: undefined;
};

// ─── Navigators ───────────────────────────────────────────────────────────────

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Welcome" component={WelcomeScreen} />
      <AuthStack.Screen name="Signup"  component={SignupScreen} />
      <AuthStack.Screen name="SeedRecovery" component={SeedRecoveryScreen} />
    </AuthStack.Navigator>
  );
}


// ─── Header avatar ─────────────────────────────────────────────────────────────

type HeaderAvatarProps = {
  profilePicUri: string | null;
  initials: string;
  onPress: () => void;
};

function HeaderAvatar({ profilePicUri, initials, onPress }: HeaderAvatarProps) {
  return (
    <TouchableOpacity style={navStyles.avatarBtn} onPress={onPress}>
      {profilePicUri ? (
        <Image source={{ uri: profilePicUri }} style={navStyles.avatarImg} />
      ) : (
        <View style={navStyles.avatarCircle}>
          <Text style={navStyles.avatarInitials}>{initials}</Text>
        </View>
      )}
      <View style={navStyles.onlineDot} />
    </TouchableOpacity>
  );
}



// ─── Screens: Profile/Settings placeholders ───────────────────────────────────

function ProfileScreen() {
  return (
    <View style={placeholderStyles.root}>
      <Text style={placeholderStyles.title}>My Profile</Text>
      <Text style={placeholderStyles.subtitle}>View and edit your profile.</Text>
    </View>
  );
}


const placeholderStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#888', marginTop: 8 },
});

function MainNavigator() {
  const [currentScreen, setCurrentScreen] = useState('Home');
  const insets = useSafeAreaInsets();

  const { keypair } = useAuthStore();
  const { myProfile, profilePicUri, localUsername, loadProfilePicUri, loadLocalUsername, fetchMyProfile } = useProfileStore();
  useEffect(() => {
    loadProfilePicUri();
    loadLocalUsername();
    fetchMyProfile();
    const publicKey = keypair?.publicKeyHex;
    if (publicKey) registerPushToken(publicKey).catch(() => {});
    const unsubscribeForeground = setupForegroundHandler();
    return () => unsubscribeForeground();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Deep link handler ──────────────────────────────────────────────────────
  const navigationRef = useRef<any>(null);

  useEffect(() => {
    function handleUrl(url: string) {
      if (!url) return;
      if (url.startsWith('gardens://invite/')) {
        const token = url.slice('gardens://invite/'.length);
        if (token) {
          // Navigate to JoinOrg — use a small timeout to ensure navigator is ready
          setTimeout(() => {
            navigationRef.current?.navigate('JoinOrg', { token });
          }, 100);
        }
      } else if (url.startsWith('gardens://dm/')) {
        const recipientKey = url.slice('gardens://dm/'.length);
        if (recipientKey) {
          import('../stores/useConversationsStore').then(({ useConversationsStore }) => {
            useConversationsStore.getState().createConversation(recipientKey).then(threadId => {
              setTimeout(() => {
                navigationRef.current?.navigate('Conversation', { threadId, recipientKey });
              }, 100);
            }).catch(() => {});
          });
        }
      }
    }

    // Cold start: app opened via deep link
    Linking.getInitialURL().then(url => { if (url) handleUrl(url); }).catch(() => {});

    // Warm start: app already open
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, []);

  const initials = (myProfile?.username ?? localUsername ?? '?').slice(0, 2).toUpperCase();

  return (
    <>
      <MainStack.Navigator
        ref={navigationRef}
        screenOptions={{
          headerStyle: { backgroundColor: '#0a0a0a' },
          headerTintColor: '#fff',
        }}
        screenListeners={{
          focus: (e) => {
            const name = e.target?.split('-')[0];
            if (name) setCurrentScreen(name);
          },
        }}
      >
        <MainStack.Screen
          name="Home"
          component={HomeScreen}
          options={() => ({
            title: 'Gardens',
            headerLeft: () => (
              <HeaderAvatar
                profilePicUri={profilePicUri}
                initials={initials}
                onPress={() => SheetManager.show('profile-sheet')}
              />
            ),
            headerRight: () => <DebugConnectionPanel />,
          })}
        />

        <MainStack.Screen
          name="Inbox"
          component={InboxScreen}
          options={{ title: 'Inbox', headerShown: true }}
        />
        <MainStack.Screen
          name="Requests"
          component={RequestsScreen}
          options={{ title: 'Message Requests', headerShown: true }}
        />
        <MainStack.Screen
          name="DiscoverOrgs"
          component={DiscoverOrgsScreen}
          options={{ title: 'Discover Communities', headerShown: true }}
        />
        <MainStack.Screen
          name="OrgChat"
          component={OrgChatScreen}
          options={{ headerShown: true }}
        />
        <MainStack.Screen
          name="Conversation"
          component={ConversationScreen}
          options={{ title: 'Conversation', headerShown: true }}
        />
        <MainStack.Screen
          name="Invite"
          component={InviteScreen}
          options={{ title: 'Generate Invite', headerShown: true }}
        />
        <MainStack.Screen
          name="OrgSettings"
          component={OrgSettingsScreen}
          options={{ title: 'Server Settings', headerShown: true }}
        />
        <MainStack.Screen
          name="MemberList"
          component={MemberListScreen}
          options={{ title: 'Members', headerShown: true }}
        />
        <MainStack.Screen
          name="AddMember"
          component={AddMemberScreen}
          options={{ title: 'Add Member', headerShown: true }}
        />
        <MainStack.Screen
          name="JoinOrg"
          component={JoinOrgScreen}
          options={{ title: 'Join Organization', headerShown: true }}
        />

        <MainStack.Screen
          name="Profile"
          component={ProfileScreen}
          options={({ navigation }) => ({
            title: 'Profile',
            headerRight: () => (
              <TouchableOpacity style={navStyles.gear} onPress={() => navigation.navigate('Settings')}>
                <Settings size={20} color="#fff" />
              </TouchableOpacity>
            ),
          })}
        />
        <MainStack.Screen
          name="Settings"
          component={UserSettingsScreen}
          options={{ title: 'Settings' }}
        />
      </MainStack.Navigator>

      {/* Floating + button — only on Home */}
      {currentScreen === 'Home' && (
        <View pointerEvents="box-none" style={[fabStyles.container, { paddingBottom: Math.max(insets.bottom, 20) }]}>
          <TouchableOpacity style={fabStyles.fab} onPress={() => SheetManager.show('fab-sheet')}>
            <Plus size={24} color="#000" />
          </TouchableOpacity>
        </View>
      )}

    </>
  );
}

const navStyles = StyleSheet.create({
  avatarBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  avatarImg: { width: 34, height: 34, borderRadius: 17 },
  avatarCircle: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#7c3aed', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { color: '#fff', fontSize: 13, fontWeight: '700' },
  onlineDot: { position: 'absolute', bottom: 4, right: 8, width: 10, height: 10, borderRadius: 5, backgroundColor: '#22c55e', borderWidth: 2, borderColor: '#0a0a0a' },
  gear: { paddingHorizontal: 12, paddingVertical: 4 },
});

const fabStyles = StyleSheet.create({
  container: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, justifyContent: 'flex-end', alignItems: 'center', padding: 20 },
  fab: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#F2E58F', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
});

// ─── Root ─────────────────────────────────────────────────────────────────────

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
        if (lockTimer.current) clearTimeout(lockTimer.current);
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

const splash = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
});

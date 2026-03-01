/**
 * RootNavigator
 *
 * Layout: Single stack with a floating circular + button that opens a bottom
 * sheet for primary actions. Header avatar opens a profile sheet. Bottom tab
 * bar removed.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Image,
} from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SheetManager } from 'react-native-actions-sheet';
import { Settings, Plus } from 'lucide-react-native';

import { useAuthStore } from '../stores/useAuthStore';
import { useProfileStore } from '../stores/useProfileStore';

import { WelcomeScreen } from '../screens/WelcomeScreen';
import { SignupScreen } from '../screens/SignupScreen';
import { SeedRecoveryScreen } from '../screens/SeedRecoveryScreen';
import { DiscoverOrgsScreen } from '../screens/DiscoverOrgsScreen';
import { InviteScreen } from '../screens/InviteScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { OrgChatScreen } from '../screens/OrgChatScreen';
import { OrgSettingsScreen } from '../screens/OrgSettingsScreen';
import { UserSettingsScreen } from '../screens/UserSettingsScreen';
import { DMChatScreen } from '../screens/DMChatScreen';
import { ConnectionBadge } from '../components/ConnectionBadge';

// ─── Param lists ──────────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Welcome: undefined;
  Signup: undefined;
  SeedRecovery: undefined;
};

export type MainStackParamList = {
  Home: undefined;
  DiscoverOrgs: undefined;
  Invite: { orgId: string; orgName: string };
  OrgChat: { orgId: string; orgName: string };
  OrgSettings: { orgId: string; orgName: string };
  DMChat: { threadId: string; recipientKey: string };
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

  const { myProfile, profilePicUri, localUsername, loadProfilePicUri, loadLocalUsername, fetchMyProfile } = useProfileStore();
  useEffect(() => {
    loadProfilePicUri();
    loadLocalUsername();
    fetchMyProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initials = (myProfile?.username ?? localUsername ?? '?').slice(0, 2).toUpperCase();

  return (
    <>
      <MainStack.Navigator
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
            title: 'Delta',
            headerLeft: () => (
              <HeaderAvatar
                profilePicUri={profilePicUri}
                initials={initials}
                onPress={() => SheetManager.show('profile-sheet')}
              />
            ),
            headerRight: () => <ConnectionBadge />,
          })}
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
          name="DMChat"
          component={DMChatScreen}
          options={({ route }) => ({
            title: `${(route.params as any).recipientKey.slice(0, 16)}...`,
            headerShown: true,
          })}
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
        <View pointerEvents="box-none" style={fabStyles.container}>
          <TouchableOpacity style={fabStyles.fab} onPress={() => SheetManager.show('fab-sheet')}>
            <Plus size={22} color="#000" />
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
  fab: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#22c55e', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
});

// ─── Root ─────────────────────────────────────────────────────────────────────

export function RootNavigator() {
  const { isUnlocked, unlockWithBiometric } = useAuthStore();

  // On mount, attempt a silent biometric unlock if a key is already stored.
  useEffect(() => {
    unlockWithBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isUnlocked === null) {
    return (
      <View style={splash.root}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return isUnlocked ? <MainNavigator /> : <AuthNavigator />;
}

const splash = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
});

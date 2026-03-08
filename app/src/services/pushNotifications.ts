import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import notifee, { AndroidImportance } from '@notifee/react-native';
import { DEFAULT_RELAY_URL } from '../stores/useProfileStore';

// ── Channel setup ─────────────────────────────────────────────────────────────

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await notifee.createChannel({
    id: 'default',
    name: 'Messages',
    importance: AndroidImportance.HIGH,
    vibration: true,
    lights: true,
  });
}

// ── Permission + token registration ──────────────────────────────────────────

export async function registerPushToken(publicKey: string): Promise<void> {
  const authStatus = await messaging().requestPermission();
  const enabled =
    authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
    authStatus === messaging.AuthorizationStatus.PROVISIONAL;

  if (!enabled) return;

  await ensureAndroidChannel();

  const token = await messaging().getToken();

  await fetch(`${DEFAULT_RELAY_URL}/push/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, token }),
  }).catch(() => {});
}

// ── Display a local notification (used for foreground + background handler) ──

export async function displayNotification(title: string, body: string, data?: Record<string, string>) {
  await ensureAndroidChannel();
  await notifee.displayNotification({
    title,
    body,
    data,
    android: { channelId: 'default', pressAction: { id: 'default' } },
  });
}

// ── Relay push helpers (called after send) ────────────────────────────────────

export async function sendDMPushNotification(params: {
  senderName: string;
  recipientKey: string;
  threadId: string;
  preview: string;
}): Promise<void> {
  await fetch(`${DEFAULT_RELAY_URL}/push/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'dm',
      recipientKeys: [params.recipientKey],
      title: params.senderName,
      body: params.preview,
      data: { threadId: params.threadId, recipientKey: params.recipientKey },
    }),
  }).catch(() => {});
}

export async function sendMentionPushNotification(params: {
  senderName: string;
  mentionedKeys: string[];
  orgName: string;
  roomId: string;
  preview: string;
}): Promise<void> {
  if (params.mentionedKeys.length === 0) return;
  await fetch(`${DEFAULT_RELAY_URL}/push/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'mention',
      recipientKeys: params.mentionedKeys,
      title: `${params.senderName} mentioned you in ${params.orgName}`,
      body: params.preview,
      data: { roomId: params.roomId },
    }),
  }).catch(() => {});
}

export async function sendMemberAddedPushNotification(params: {
  recipientKey: string;
  orgName: string;
  orgId: string;
  accessLevel: string;
}): Promise<void> {
  await fetch(`${DEFAULT_RELAY_URL}/push/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'member_added',
      recipientKeys: [params.recipientKey],
      title: `You've been added to ${params.orgName}`,
      body: `Access level: ${params.accessLevel}. Tap to accept.`,
      data: { type: 'member_added', orgId: params.orgId, accessLevel: params.accessLevel },
    }),
  }).catch(() => {});
}

// ── Background message handler (call once at app root) ───────────────────────

export function setupBackgroundHandler() {
  messaging().setBackgroundMessageHandler(async (remoteMessage) => {
    const { title, body } = remoteMessage.notification ?? {};
    if (title && body) {
      await displayNotification(title, body, remoteMessage.data as Record<string, string>);
    }
  });
}

// ── Foreground message handler (call once after auth) ────────────────────────

export function setupForegroundHandler(): () => void {
  return messaging().onMessage(async (remoteMessage) => {
    const { title, body } = remoteMessage.notification ?? {};
    if (title && body) {
      await displayNotification(title, body, remoteMessage.data as Record<string, string>);
    }
  });
}

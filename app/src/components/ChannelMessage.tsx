import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import type { Message } from '../stores/useMessagesStore';
import { BlobImage } from './BlobImage';
import { DEFAULT_RELAY_URL } from '../stores/useProfileStore';
import { BlobVideo } from './BlobVideo';
import { getBlob } from '../ffi/gardensCore';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import { MessageText, extractUrls } from './MessageText';
import { LinkPreview } from './LinkPreview';
import { Mail } from 'lucide-react-native';

const AVATAR_COLORS = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#3498DB', '#E67E22'];

function avatarColor(publicKey: string): string {
  let hash = 0;
  for (let i = 0; i < publicKey.length; i++) {
    hash = publicKey.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function Avatar({
  authorKey,
  username,
  avatarBlobId,
  avatarUri,
  isIced,
}: {
  authorKey: string;
  username: string;
  avatarBlobId: string | null;
  avatarUri?: string | null;
  isIced?: boolean;
}) {
  const color = avatarColor(authorKey);
  const initials = username.slice(0, 2).toUpperCase();

  if (avatarUri) {
    return (
      <View style={styles.avatarWrap}>
        <Image source={{ uri: avatarUri }} style={[styles.avatar, { borderRadius: 18 }]} />
        {isIced && <Text style={styles.iceBadge}>🧊</Text>}
      </View>
    );
  }

  if (avatarBlobId) {
    return (
      <View style={styles.avatarWrap}>
        <BlobImage
          blobHash={avatarBlobId}
          roomId={null}
          peerPublicKey={authorKey}
          publicRelayUrl={DEFAULT_RELAY_URL}
          style={[styles.avatar, { borderRadius: 18 }]}
        />
        {isIced && <Text style={styles.iceBadge}>🧊</Text>}
      </View>
    );
  }

  return (
    <View style={[styles.avatar, { backgroundColor: color }]}>
      <Text style={styles.avatarInitials}>{initials}</Text>
      {isIced && <Text style={styles.iceBadge}>🧊</Text>}
    </View>
  );
}

function AudioMessage({ blobHash, roomId }: { blobHash: string; roomId: string | null }) {
  const [playing, setPlaying] = useState(false);
  const playerRef = React.useRef<AudioRecorderPlayer | null>(null);

  async function toggle() {
    if (playing) {
      await playerRef.current?.stopPlayer();
      playerRef.current?.removePlayBackListener();
      setPlaying(false);
    } else {
      try {
        const bytes = await getBlob(blobHash, roomId);
        const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
        const uri = `data:audio/m4a;base64,${btoa(binary)}`;
        const player = new AudioRecorderPlayer();
        playerRef.current = player;
        player.addPlayBackListener((e) => {
          if (e.isFinished) {
            setPlaying(false);
            player.stopPlayer();
            player.removePlayBackListener();
          }
        });
        await player.startPlayer(uri);
        setPlaying(true);
      } catch {
        // silently fail
      }
    }
  }

  return (
    <TouchableOpacity style={styles.audioBtn} onPress={toggle}>
      <Text style={styles.audioBtnText}>{playing ? '⏸' : '▶'}</Text>
      <Text style={styles.audioLabel}>Voice message</Text>
    </TouchableOpacity>
  );
}

interface Props {
  message: Message;
  isOwnMessage: boolean;
  isGrouped: boolean;
  authorUsername: string;
  authorAvatarBlobId: string | null;
  authorAvatarUri?: string | null;
  authorIced?: boolean;
  replyToPreview?: { username: string; text: string; isDeleted?: boolean } | null;
  reactions?: Array<{ emoji: string; count: number; reactedByMe: boolean }>;
  customEmojis?: Record<string, { blobId: string; mimeType: string; roomId: string | null }>;
  onToggleReaction?: (emoji: string) => void;
  onReply?: () => void;
  onLongPress?: () => void;
}

export function ChannelMessage({
  message,
  isOwnMessage,
  isGrouped,
  authorUsername,
  authorAvatarBlobId,
  authorAvatarUri,
  authorIced,
  replyToPreview,
  reactions = [],
  customEmojis = {},
  onToggleReaction,
  onReply,
  onLongPress,
}: Props) {
  const color = avatarColor(message.authorKey);
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (message.isDeleted) {
    return (
      <View style={[styles.row, isGrouped && styles.rowGrouped]}>
        <View style={styles.avatarSlot} />
        <Text style={styles.deletedText}>Message deleted</Text>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.row, isGrouped && styles.rowGrouped]}
      onLongPress={onLongPress}
      activeOpacity={0.85}
    >
      {/* Avatar or spacer */}
      <View style={styles.avatarSlot}>
        {!isGrouped && (
          <Avatar
            authorKey={message.authorKey}
            username={authorUsername}
            avatarBlobId={authorAvatarBlobId}
            avatarUri={authorAvatarUri}
            isIced={authorIced}
          />
        )}
      </View>

      {/* Content column */}
      <View style={styles.content}>
        {/* Username + timestamp row */}
        {!isGrouped && (
          <View style={styles.header}>
            <Text style={[styles.username, { color }, isOwnMessage && styles.usernameOwn]}>
              {authorUsername}
            </Text>
            <Text style={styles.headerTimestamp}>{timestamp}</Text>
          </View>
        )}

        {/* Reply bar */}
        {message.replyTo && replyToPreview && (
          <View style={styles.replyPreview}>
            <View style={styles.replyPreviewInner}>
              <Text style={styles.replyPreviewUser}>@{replyToPreview.username}</Text>
              <Text style={styles.replyPreviewText} numberOfLines={2}>
                {replyToPreview.isDeleted ? 'Message deleted' : replyToPreview.text}
              </Text>
            </View>
          </View>
        )}

        {/* Message body */}
        {message.contentType === 'text' && message.textContent && (() => {
          const urls = extractUrls(message.textContent);
          return (
            <>
              <View style={styles.textRow}>
                <MessageText text={message.textContent} customEmojis={customEmojis} />
                {isGrouped && <Text style={styles.inlineTimestamp}>{timestamp}</Text>}
              </View>
              {urls.slice(0, 1).map(url => (
                <LinkPreview key={url} url={url} />
              ))}
            </>
          );
        })()}

        {message.contentType === 'email' && (() => {
          let emailData: { from?: string; subject?: string; body_text?: string } = {};
          try {
            emailData = JSON.parse(message.textContent ?? '{}');
          } catch {}
          return (
            <View style={emailStyles.card}>
              <View style={emailStyles.header}>
                <Mail size={14} color="#888" />
                <Text style={emailStyles.from}>{emailData.from ?? 'Unknown sender'}</Text>
              </View>
              <Text style={emailStyles.subject}>{emailData.subject ?? '(no subject)'}</Text>
              <Text style={emailStyles.preview} numberOfLines={2}>{emailData.body_text ?? ''}</Text>
            </View>
          );
        })()}

        {message.contentType === 'image' && message.blobId && (
          <BlobImage blobHash={message.blobId} roomId={message.roomId ?? null} style={styles.media} />
        )}

        {message.contentType === 'audio' && message.blobId && (
          <AudioMessage blobHash={message.blobId} roomId={message.roomId ?? null} />
        )}

        {message.contentType === 'gif' && message.embedUrl && (
          <Image source={{ uri: message.embedUrl }} style={styles.media} resizeMode="cover" />
        )}

        {message.contentType === 'video' && message.blobId && message.roomId && (
          <BlobVideo blobHash={message.blobId} topicHex={message.roomId} style={styles.media} />
        )}

        {message.editedAt && <Text style={styles.edited}>(edited)</Text>}

        {reactions.length > 0 && (
          <View style={styles.reactionsRow}>
            {reactions.map((r) => {
              const custom = customEmojis[r.emoji];
              return (
                <TouchableOpacity
                  key={`${message.messageId}-${r.emoji}`}
                  style={[styles.reactionBadge, r.reactedByMe && styles.reactionBadgeActive]}
                  onPress={() => onToggleReaction?.(r.emoji)}
                  activeOpacity={0.8}
                >
                  {custom ? (
                    <BlobImage
                      blobHash={custom.blobId}
                      mimeType={custom.mimeType}
                      roomId={custom.roomId}
                      style={styles.reactionEmojiImg}
                    />
                  ) : (
                    <Text style={styles.reactionEmojiText}>{r.emoji}</Text>
                  )}
                  <Text style={styles.reactionCount}>{r.count}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

      {/* Reply button */}
      {onReply && (
        <TouchableOpacity style={styles.replyBtn} onPress={onReply}>
          <Text style={styles.replyBtnText}>↩</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 2,
    alignItems: 'flex-start',
  },
  rowGrouped: {
    paddingTop: 2,
  },

  avatarSlot: {
    width: 40,
    marginRight: 10,
    alignItems: 'center',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  iceBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    fontSize: 12,
  },

  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 3,
  },
  username: {
    fontSize: 14,
    fontWeight: '600',
  },
  usernameOwn: {
    opacity: 1,
  },
  headerTimestamp: {
    color: '#555',
    fontSize: 11,
  },

  textRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
  },
inlineTimestamp: {
    color: '#555',
    fontSize: 10,
    marginBottom: 2,
  },

  replyPreview: {
    marginBottom: 6,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: '#2a2a2a',
  },
  replyPreviewInner: {
    backgroundColor: '#141414',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  replyPreviewUser: { color: '#8ab4f8', fontSize: 12, fontWeight: '600' },
  replyPreviewText: { color: '#bbb', fontSize: 12, marginTop: 2 },

  media: { width: '100%', minHeight: 160, borderRadius: 6, marginTop: 4 },
  edited: { color: '#555', fontSize: 11, fontStyle: 'italic', marginTop: 2 },

  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  reactionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#1b1b1b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  reactionBadgeActive: { borderColor: '#3b82f6' },
  reactionEmojiText: { fontSize: 14 },
  reactionEmojiImg: { width: 14, height: 14, borderRadius: 3 },
  reactionCount: { color: '#bbb', fontSize: 12 },

  deletedText: { color: '#555', fontSize: 14, fontStyle: 'italic', flex: 1, paddingTop: 2 },

  replyBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#1e1e1e',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
    alignSelf: 'center',
  },
  replyBtnText: { color: '#888', fontSize: 14 },

  audioBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  audioBtnText: { color: '#fff', fontSize: 20 },
  audioLabel: { color: '#aaa', fontSize: 13 },
});

const emailStyles = StyleSheet.create({
  card: { backgroundColor: '#1a1a1a', borderRadius: 8, padding: 12, borderLeftWidth: 3, borderLeftColor: '#F2E58F' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  from: { color: '#888', fontSize: 12 },
  subject: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 4 },
  preview: { color: '#666', fontSize: 13 },
});

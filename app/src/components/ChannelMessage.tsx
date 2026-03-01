import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import type { Message } from '../stores/useMessagesStore';
import { BlobImage } from './BlobImage';
import { getBlob } from '../ffi/deltaCore';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import { MessageText, extractUrls } from './MessageText';
import { LinkPreview } from './LinkPreview';

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
}: {
  authorKey: string;
  username: string;
  avatarBlobId: string | null;
}) {
  const color = avatarColor(authorKey);
  const initials = username.slice(0, 2).toUpperCase();

  if (avatarBlobId) {
    return (
      <BlobImage
        blobHash={avatarBlobId}
        style={[styles.avatar, { borderRadius: 18 }]}
      />
    );
  }

  return (
    <View style={[styles.avatar, { backgroundColor: color }]}>
      <Text style={styles.avatarInitials}>{initials}</Text>
    </View>
  );
}

function AudioMessage({ blobHash }: { blobHash: string }) {
  const [playing, setPlaying] = useState(false);
  const playerRef = React.useRef<AudioRecorderPlayer | null>(null);

  async function toggle() {
    if (playing) {
      await playerRef.current?.stopPlayer();
      playerRef.current?.removePlayBackListener();
      setPlaying(false);
    } else {
      try {
        const bytes = await getBlob(blobHash);
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
  onReply?: () => void;
  onLongPress?: () => void;
}

export function ChannelMessage({
  message,
  isOwnMessage,
  isGrouped,
  authorUsername,
  authorAvatarBlobId,
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
        {message.replyTo && (
          <View style={styles.replyBar}>
            <Text style={styles.replyText}>↩ Reply</Text>
          </View>
        )}

        {/* Message body */}
        {message.contentType === 'text' && message.textContent && (() => {
          const urls = extractUrls(message.textContent);
          return (
            <>
              <View style={styles.textRow}>
                <MessageText text={message.textContent} />
                {isGrouped && <Text style={styles.inlineTimestamp}>{timestamp}</Text>}
              </View>
              {urls.slice(0, 1).map(url => (
                <LinkPreview key={url} url={url} />
              ))}
            </>
          );
        })()}

        {message.contentType === 'image' && message.blobId && (
          <BlobImage blobHash={message.blobId} style={styles.media} />
        )}

        {message.contentType === 'audio' && message.blobId && (
          <AudioMessage blobHash={message.blobId} />
        )}

        {message.contentType === 'gif' && message.embedUrl && (
          <Image source={{ uri: message.embedUrl }} style={styles.media} resizeMode="cover" />
        )}

        {message.contentType === 'video' && message.blobId && (
          <BlobImage blobHash={message.blobId} style={styles.media} mimeType="image/jpeg" />
        )}

        {message.editedAt && <Text style={styles.edited}>(edited)</Text>}
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
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
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

  replyBar: {
    borderLeftWidth: 3,
    borderLeftColor: '#555',
    paddingLeft: 8,
    marginBottom: 4,
  },
  replyText: { color: '#888', fontSize: 12 },

  media: { width: '100%', minHeight: 160, borderRadius: 6, marginTop: 4 },
  edited: { color: '#555', fontSize: 11, fontStyle: 'italic', marginTop: 2 },

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

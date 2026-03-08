import React, { useState, useRef, useEffect } from 'react';
import { X, SendHorizontal, Mic, Camera, Smile } from 'lucide-react-native';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetManager } from 'react-native-actions-sheet';
import { launchImageLibrary } from 'react-native-image-picker';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import RNFS from 'react-native-fs';
import { uploadBlob, initNetwork, isNetworkInitialized } from '../ffi/gardensCore';
import { GifSearchModal } from './GifSearchModal';
import { STANDARD_EMOJI_BY_CODE, STANDARD_EMOJI_CODES } from '../data/emoji';
import { BlobImage } from './BlobImage';

// Helper to convert base64 to Uint8Array without atob
function base64ToBytes(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  const len = base64.length;
  let padding = 0;
  if (base64[len - 2] === '=') padding = 2;
  else if (base64[len - 1] === '=') padding = 1;

  const bytesLen = (len * 3 / 4) - padding;
  const bytes = new Uint8Array(bytesLen);

  let i = 0;
  let j = 0;
  while (i < len) {
    const a = lookup[base64.charCodeAt(i++)];
    const b = lookup[base64.charCodeAt(i++)];
    const c = lookup[base64.charCodeAt(i++)];
    const d = lookup[base64.charCodeAt(i++)];

    bytes[j++] = (a << 2) | (b >> 4);
    if (j < bytesLen) bytes[j++] = ((b & 15) << 4) | (c >> 2);
    if (j < bytesLen) bytes[j++] = ((c & 3) << 6) | d;
  }

  return bytes;
}

const audioRecorderPlayer = new AudioRecorderPlayer();

interface Props {
  roomId?: string | null;
  onSend: (text: string) => void;
  onSendBlob?: (blobId: string, mimeType: string, contentType: 'image' | 'video') => void;
  onSendAudio?: (blobId: string) => void;
  onSendGif?: (embedUrl: string) => void;
  placeholder?: string;
  replyingTo?: string | null;
  onCancelReply?: () => void;
  customEmojiCodes?: string[];
  customEmojis?: Record<string, { blobId: string; mimeType: string; roomId: string | null }>;
  mentionCandidates?: string[];
  channelCandidates?: string[];
  prefillText?: string | null;
  onPrefillApplied?: () => void;
}

export function MessageComposer({
  roomId = null,
  onSend,
  onSendBlob,
  onSendAudio,
  onSendGif,
  placeholder = 'Message...',
  replyingTo,
  onCancelReply,
  customEmojiCodes = [],
  customEmojis = {},
  mentionCandidates = [],
  channelCandidates = [],
  prefillText,
  onPrefillApplied,
}: Props) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [gifVisible, setGifVisible] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const recordingRef = useRef<boolean>(false);
  useEffect(() => {
    if (!prefillText) return;
    setText(prev => {
      if (!prev) return prefillText;
      const needsSpace = !prev.endsWith(' ');
      return needsSpace ? `${prev} ${prefillText}` : `${prev}${prefillText}`;
    });
    onPrefillApplied?.();
  }, [prefillText, onPrefillApplied]);

  const insets = useSafeAreaInsets();

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  async function pickMedia() {
    try {
      const ok = await isNetworkInitialized();
      if (!ok) await initNetwork(null);
      const result = await launchImageLibrary({ 
        mediaType: 'mixed', 
        includeBase64: true,
        maxWidth: 1920,
        maxHeight: 1920,
        quality: 0.8,
      });
      const asset = result.assets?.[0];
      if (!asset) return;

      const isVideo = asset.type?.startsWith('video') ?? false;
      const mimeType = asset.type ?? (isVideo ? 'video/mp4' : 'image/jpeg');
      const contentType: 'image' | 'video' = isVideo ? 'video' : 'image';

      let bytes: Uint8Array;

      if (asset.base64) {
        // Use base64 data directly (works on both platforms)
        bytes = base64ToBytes(asset.base64);
      } else if (asset.uri) {
        // Fallback to react-native-fs if no base64 (handles file:// URIs properly)
        try {
          const base64Data = await RNFS.readFile(asset.uri, 'base64');
          bytes = base64ToBytes(base64Data);
        } catch (readErr) {
          console.error('Failed to read image file:', readErr);
          throw new Error('Failed to read image file');
        }
      } else {
        throw new Error('No image data available');
      }

      const blobId = await uploadBlob(bytes, mimeType, roomId);

      // Blob is stored in the core's P2P blob store
      if (roomId) {
        // Placeholder for future holder registration if needed
        console.log(`[upload] Registering blob ${blobId} holder for topic ${roomId}`);
      } else {
        console.warn('[upload] No roomId available, skipping holder registration');
      }
      
      onSendBlob?.(blobId, mimeType, contentType);
    } catch (err: any) {
      console.error('Error sending media:', err);
      // Could show an error toast here
    }
  }

  async function startRecording() {
    try {
      await audioRecorderPlayer.startRecorder();
      recordingRef.current = true;
      setRecording(true);
    } catch {
      // Permission denied or mic unavailable — fail silently
    }
  }

  async function stopRecording() {
    setRecording(false);
    if (!recordingRef.current) return;
    recordingRef.current = false;
    try {
      const ok = await isNetworkInitialized();
      if (!ok) await initNetwork(null);
      const uri = await audioRecorderPlayer.stopRecorder();
      if (!uri) return;
      const resp = await fetch(uri);
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const blobId = await uploadBlob(bytes, 'audio/m4a', roomId);
      onSendAudio?.(blobId);
    } catch {
      // silently fail
    }
  }

  const showPtt = text.trim().length === 0;
  const emojiQueryMatch = text.match(/(^|\s)(:[a-zA-Z0-9_+-]{0,})$/);
  const emojiQuery = emojiQueryMatch?.[2] ?? '';
  const emojiSuggestions = emojiQuery
    ? (() => {
        const customMatches = customEmojiCodes.filter(code => code.startsWith(emojiQuery));
        const standardMatches = STANDARD_EMOJI_CODES.filter(code => code.startsWith(emojiQuery));
        const seen = new Set<string>();
        const combined = [...customMatches, ...standardMatches].filter(code => {
          if (seen.has(code)) return false;
          seen.add(code);
          return true;
        });
        return combined.slice(0, 6);
      })()
    : [];

  const mentionQueryMatch = text.match(/(^|\s)@([a-zA-Z0-9_+-]*)$/);
  const mentionQuery = mentionQueryMatch?.[2] ?? '';
  const mentionSuggestions = mentionQueryMatch
    ? mentionCandidates
        .filter(name => name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
        .slice(0, 6)
    : [];

  const channelQueryMatch = text.match(/(^|\s)#([a-zA-Z0-9_+-]*)$/);
  const channelQuery = channelQueryMatch?.[2] ?? '';
  const channelSuggestions = channelQueryMatch
    ? channelCandidates
        .filter(name => name.toLowerCase().startsWith(channelQuery.toLowerCase()))
        .slice(0, 6)
    : [];

  function applyEmoji(code: string) {
    const next = text.replace(/(^|\s)(:[a-zA-Z0-9_+-]{0,})$/, `$1${code} `);
    setText(next);
  }

  function applyMention(username: string) {
    const next = text.replace(/(^|\s)@([a-zA-Z0-9_+-]*)$/, `$1@${username} `);
    setText(next);
  }

  function applyChannel(name: string) {
    const next = text.replace(/(^|\s)#([a-zA-Z0-9_+-]*)$/, `$1#${name} `);
    setText(next);
  }

  function insertEmoji(value: string) {
    // If user is typing a :code: query, replace that token; otherwise append.
    if (emojiQueryMatch && value.startsWith(':') && value.endsWith(':')) {
      applyEmoji(value);
      return;
    }
    setText(prev => (prev ? `${prev}${value} ` : `${value} `));
  }

  function openEmojiPicker() {
    SheetManager.show('emoji-picker-sheet', {
      payload: {
        customEmojis,
        onSelect: insertEmoji,
      },
    });
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {replyingTo && (
        <View style={styles.replyBar}>
          <Text style={styles.replyText}>Replying to message...</Text>
          {onCancelReply && (
            <TouchableOpacity onPress={onCancelReply}>
              <X size={16} color="#888" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {trayOpen && (
        <View style={styles.tray}>
          <TouchableOpacity style={styles.trayItem} onPress={() => { setTrayOpen(false); pickMedia(); }}>
            <View style={[styles.trayIconCircle, { backgroundColor: '#7c3aed' }]}>
              <Camera size={22} color="#fff" />
            </View>
            <Text style={styles.trayLabel}>Photo & Video</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.trayItem} onPress={() => { setTrayOpen(false); setGifVisible(true); }}>
            <View style={[styles.trayIconCircle, { backgroundColor: '#0891b2' }]}>
              <Text style={styles.gifBadge}>GIF</Text>
            </View>
            <Text style={styles.trayLabel}>GIF</Text>
          </TouchableOpacity>
        </View>
      )}

      {emojiSuggestions.length > 0 && (
        <View style={styles.emojiSuggestRow}>
          {emojiSuggestions.map(code => (
            <TouchableOpacity key={code} style={styles.emojiSuggestBtn} onPress={() => applyEmoji(code)}>
              {customEmojis[code] ? (
                <>
                  <BlobImage
                    blobHash={customEmojis[code].blobId}
                    mimeType={customEmojis[code].mimeType}
                    roomId={customEmojis[code].roomId}
                    style={styles.customEmojiPreview}
                  />
                  <Text style={styles.emojiSuggestText}>{code}</Text>
                </>
              ) : (
                <Text style={styles.emojiSuggestText}>
                  {STANDARD_EMOJI_BY_CODE[code] ? `${STANDARD_EMOJI_BY_CODE[code]} ${code}` : code}
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {mentionSuggestions.length > 0 && (
        <View style={styles.emojiSuggestRow}>
          {mentionSuggestions.map(name => (
            <TouchableOpacity key={name} style={styles.emojiSuggestBtn} onPress={() => applyMention(name)}>
              <Text style={styles.emojiSuggestText}>@{name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {channelSuggestions.length > 0 && (
        <View style={styles.emojiSuggestRow}>
          {channelSuggestions.map(name => (
            <TouchableOpacity key={name} style={styles.emojiSuggestBtn} onPress={() => applyChannel(name)}>
              <Text style={styles.emojiSuggestText}>#{name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={[styles.container, { paddingBottom: 12 + insets.bottom }]}>
        <TouchableOpacity style={[styles.attachBtn, trayOpen && styles.attachBtnActive]} onPress={() => setTrayOpen(o => !o)}>
          <Text style={styles.attachText}>{trayOpen ? '×' : '+'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.emojiBtn} onPress={openEmojiPicker}>
          <Smile size={18} color="#9ca3af" />
        </TouchableOpacity>

        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor="#555"
          value={text}
          onChangeText={setText}
          multiline
          maxLength={4000}
          returnKeyType="default"
        />

        {showPtt ? (
          <TouchableOpacity
            style={[styles.pttBtn, recording && styles.pttBtnActive]}
            onPressIn={startRecording}
            onPressOut={stopRecording}
          >
            <Mic size={18} color={recording ? '#fff' : '#888'} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!text.trim()}
          >
            <SendHorizontal size={18} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

      <GifSearchModal
        visible={gifVisible}
        onSelect={(url) => { onSendGif?.(url); setGifVisible(false); }}
        onClose={() => setGifVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingTop: 12,
    paddingHorizontal: 12,
    paddingBottom: 12,
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
    gap: 8,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  replyText: { color: '#888', fontSize: 13 },
  cancelText: { color: '#888', fontSize: 18, paddingHorizontal: 8 },
  tray: {
    flexDirection: 'row',
    gap: 20,
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: '#111',
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  emojiSuggestRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  emojiSuggestBtn: {
    backgroundColor: '#1b1b1b',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  emojiSuggestText: { color: '#e5e7eb', fontSize: 12, fontWeight: '600' },
  customEmojiPreview: { width: 16, height: 16, borderRadius: 4 },
  trayItem: {
    alignItems: 'center',
    gap: 8,
  },
  trayIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gifBadge: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  trayLabel: { color: '#888', fontSize: 12 },
  attachBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center',
  },
  attachBtnActive: { backgroundColor: '#2a2a2a' },
  attachText: { color: '#888', fontSize: 24, fontWeight: '300' },
  emojiBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
    color: '#fff',
    fontSize: 15,
    maxHeight: 100,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#f97316', alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#374151', opacity: 0.5 },
  pttBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center',
  },
  pttBtnActive: { backgroundColor: '#ef4444' },
});

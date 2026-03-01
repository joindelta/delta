import React, { useState, useRef } from 'react';
import { X, SendHorizontal, Mic, Camera } from 'lucide-react-native';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import { uploadBlob } from '../ffi/deltaCore';
import { GifSearchModal } from './GifSearchModal';

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
}: Props) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [gifVisible, setGifVisible] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const recordingRef = useRef<boolean>(false);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  async function pickMedia() {
    const result = await launchImageLibrary({ mediaType: 'mixed', includeBase64: false });
    const asset = result.assets?.[0];
    if (!asset || !asset.uri) return;

    const isVideo = asset.type?.startsWith('video') ?? false;
    const mimeType = asset.type ?? (isVideo ? 'video/mp4' : 'image/jpeg');
    const contentType: 'image' | 'video' = isVideo ? 'video' : 'image';

    // Read bytes via fetch (works for both file:// and ph:// URIs on RN).
    const resp = await fetch(asset.uri);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    const blobId = await uploadBlob(bytes, mimeType, roomId);
    onSendBlob?.(blobId, mimeType, contentType);
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

      <View style={styles.container}>
        <TouchableOpacity style={[styles.attachBtn, trayOpen && styles.attachBtnActive]} onPress={() => setTrayOpen(o => !o)}>
          <Text style={styles.attachText}>{trayOpen ? '×' : '+'}</Text>
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
    padding: 12,
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

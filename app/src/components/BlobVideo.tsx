import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  StyleProp,
  ViewStyle,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import Video from 'react-native-video';
import { Play, Download, AlertCircle } from 'lucide-react-native';
import { 
  hasBlob, 
  getBlob, 
} from '../ffi/gardensCore';
import RNFS from 'react-native-fs';

// Helper to convert Uint8Array to base64 string (React Native compatible)
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let base64 = '';
  let i = 0;
  
  while (i < bytes.length) {
    const byte1 = bytes[i++];
    const byte2 = i < bytes.length ? bytes[i++] : 0;
    const byte3 = i < bytes.length ? bytes[i++] : 0;
    
    const encoded1 = byte1 >> 2;
    const encoded2 = ((byte1 & 0x03) << 4) | (byte2 >> 4);
    const encoded3 = ((byte2 & 0x0f) << 2) | (byte3 >> 6);
    const encoded4 = byte3 & 0x3f;
    
    base64 += chars[encoded1] + chars[encoded2];
    base64 += i - 2 < bytes.length ? chars[encoded3] : '=';
    base64 += i - 1 < bytes.length ? chars[encoded4] : '=';
  }
  
  return base64;
}

interface Props {
  blobHash: string;
  topicHex: string;  // Room/thread ID for peer discovery
  style?: StyleProp<ViewStyle>;
}

type VideoState = 
  | { type: 'checking' }  // Checking local storage and DO
  | { type: 'available'; localPath: string }  // Available locally
  | { type: 'downloading'; progress: number }  // P2P download in progress
  | { type: 'unavailable'; reason: string }  // No holders found
  | { type: 'error'; message: string };  // Error occurred

/**
 * BlobVideo - Video player that fetches via P2P using core peer discovery.
 * 
 * Flow:
 * 1. Check if blob exists locally
 * 2. If not, query DO for holders
 * 3. If holders exist, P2P request from one
 * 4. Save to temp file and play
 */
export function BlobVideo({ blobHash, topicHex, style }: Props) {
  const [state, setState] = useState<VideoState>({ type: 'checking' });
  const [isPlaying, _setIsPlaying] = useState(false);

  const checkAndFetchBlob = useCallback(async () => {
    setState({ type: 'checking' });

    try {
      // Step 1: Check if we already have the blob locally
      const hasLocally = await hasBlob(blobHash);
      if (hasLocally) {
        const blobData = await getBlob(blobHash, topicHex);
        const tempPath = `${RNFS.TemporaryDirectoryPath}/${blobHash}.mp4`;
        await RNFS.writeFile(tempPath, uint8ArrayToBase64(blobData), 'base64');
        setState({ type: 'available', localPath: tempPath });
        return;

      }

      // Step 2: Attempt P2P fetch via core (iroh-blobs)
      setState({ type: 'downloading', progress: 0 });
      const blobData = await getBlob(blobHash, topicHex);
      const tempPath = `${RNFS.TemporaryDirectoryPath}/${blobHash}.mp4`;
      await RNFS.writeFile(tempPath, uint8ArrayToBase64(blobData), 'base64');
      setState({ type: 'available', localPath: tempPath });
    } catch (error) {
      console.error('BlobVideo error:', error);
      const msg = String(error);
      if (msg.includes('NotFound') || msg.includes('not found')) {
        setState({ type: 'unavailable', reason: 'No peers have this video' });
      } else {
        setState({ type: 'error', message: msg });
      }
    }
  }, [blobHash, topicHex]);

  useEffect(() => {
    checkAndFetchBlob();
  }, [checkAndFetchBlob]);

  const renderContent = () => {
    switch (state.type) {
      case 'checking':
        return (
          <View style={styles.centerContent}>
            <Play size={32} color="#666" />
            <Text style={styles.statusText}>Checking availability...</Text>
          </View>
        );

      case 'unavailable':
        return (
          <View style={styles.centerContent}>
            <AlertCircle size={32} color="#666" />
            <Text style={styles.statusText}>{state.reason}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={checkAndFetchBlob}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        );

      case 'downloading':
        return (
          <View style={styles.centerContent}>
            <Download size={32} color="#f97316" />
            <Text style={styles.statusText}>Downloading via P2P...</Text>
          </View>
        );

      case 'error':
        return (
          <View style={styles.centerContent}>
            <AlertCircle size={32} color="#ef4444" />
            <Text style={[styles.statusText, styles.errorText]}>{state.message}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={checkAndFetchBlob}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        );

      case 'available':
        return (
          <Video
            source={{ uri: state.localPath }}
            style={styles.video}
            controls={true}
            resizeMode="contain"
            paused={!isPlaying}
            onError={(e) => {
              console.error('Video playback error:', e);
              setState({ type: 'error', message: 'Playback failed' });
            }}
            bufferConfig={{
              minBufferMs: 15000,
              maxBufferMs: 50000,
              bufferForPlaybackMs: 2500,
              bufferForPlaybackAfterRebufferMs: 5000,
            }}
            useTextureView={false}
          />
        );
    }
  };

  return (
    <View style={[styles.container, style]}>
      {renderContent()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    overflow: 'hidden',
    minHeight: 200,
  },
  video: {
    width: '100%',
    height: '100%',
    minHeight: 200,
  },
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
    padding: 16,
  },
  statusText: {
    color: '#888',
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
  },
  errorText: {
    color: '#ef4444',
  },
  retryButton: {
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
  },
  retryText: {
    color: '#f97316',
    fontSize: 14,
    fontWeight: '600',
  },
});

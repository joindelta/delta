import React, { useEffect, useState } from 'react';
import {
  Image,
  ImageStyle,
  StyleProp,
  View,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { getBlob, requestBlobFromPeer } from '../ffi/gardensCore';

interface Props {
  blobHash: string;
  style?: StyleProp<ImageStyle>;
  mimeType?: string; // defaults to 'image/jpeg'
  roomId?: string | null;
  peerPublicKey?: string | null;
  publicRelayUrl?: string | null; // fallback: fetch from relay public KV
}

type State = { status: 'loading' } | { status: 'ready'; uri: string } | { status: 'error' };

export function BlobImage({
  blobHash,
  style,
  mimeType = 'image/jpeg',
  roomId = null,
  peerPublicKey = null,
  publicRelayUrl = null,
}: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const bytes = await getBlob(blobHash, roomId);
        if (cancelled) return;
        const binary = Array.from(bytes)
          .map((b) => String.fromCharCode(b))
          .join('');
        const b64 = btoa(binary);
        setState({ status: 'ready', uri: `data:${mimeType};base64,${b64}` });
        return;
      } catch {
        // fall through to peer fetch
      }

      if (peerPublicKey) {
        try {
          const bytes = await requestBlobFromPeer(blobHash, peerPublicKey);
          if (!cancelled && bytes) {
            const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
            setState({ status: 'ready', uri: `data:${mimeType};base64,${btoa(binary)}` });
            return;
          }
        } catch {
          // fall through to relay
        }
      }

      if (publicRelayUrl) {
        try {
          const resp = await fetch(`${publicRelayUrl}/public-blob/${blobHash}`);
          if (!cancelled && resp.ok) {
            const buf = await resp.arrayBuffer();
            const binary = Array.from(new Uint8Array(buf)).map((b) => String.fromCharCode(b)).join('');
            const respMime = resp.headers.get('Content-Type') ?? mimeType;
            setState({ status: 'ready', uri: `data:${respMime};base64,${btoa(binary)}` });
            return;
          }
        } catch {
          // fall through
        }
      }

      if (!cancelled) setState({ status: 'error' });
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [blobHash, mimeType, roomId, peerPublicKey, publicRelayUrl]);

  if (state.status === 'loading') {
    return (
      <View style={[styles.placeholder, style as object]}>
        <ActivityIndicator color="#888" />
      </View>
    );
  }
  if (state.status === 'error') {
    return <View style={[styles.placeholder, style as object]} />;
  }
  return <Image source={{ uri: state.uri }} style={style} resizeMode="cover" />;
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
});

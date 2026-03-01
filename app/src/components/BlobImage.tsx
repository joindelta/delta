import React, { useEffect, useState } from 'react';
import {
  Image,
  ImageStyle,
  StyleProp,
  View,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { getBlob } from '../ffi/deltaCore';

interface Props {
  blobHash: string;
  style?: StyleProp<ImageStyle>;
  mimeType?: string; // defaults to 'image/jpeg'
}

type State = { status: 'loading' } | { status: 'ready'; uri: string } | { status: 'error' };

export function BlobImage({ blobHash, style, mimeType = 'image/jpeg' }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    getBlob(blobHash)
      .then((bytes) => {
        if (cancelled) return;
        // Convert Uint8Array → base64 string.
        const binary = Array.from(bytes)
          .map((b) => String.fromCharCode(b))
          .join('');
        const b64 = btoa(binary);
        setState({ status: 'ready', uri: `data:${mimeType};base64,${b64}` });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [blobHash, mimeType]);

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
    minHeight: 120,
    borderRadius: 8,
  },
});

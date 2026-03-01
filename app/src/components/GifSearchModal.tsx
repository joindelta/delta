// app/src/components/GifSearchModal.tsx
import React, { useState, useCallback } from 'react';
import { X } from 'lucide-react-native';
import {
  Modal,
  View,
  TextInput,
  FlatList,
  Image,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { TENOR_API_KEY } from '../utils/config';

interface GifResult {
  id: string;
  url: string;
  preview: string;
}

interface Props {
  visible: boolean;
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

export function GifSearchModal({ visible, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const url =
        `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}` +
        `&key=${TENOR_API_KEY}&limit=20&media_filter=gif`;
      const res = await fetch(url);
      const data = await res.json();
      const gifs: GifResult[] = (data.results ?? []).map((r: any) => ({
        id: r.id,
        url: r.media_formats?.gif?.url ?? '',
        preview: r.media_formats?.tinygif?.url ?? r.media_formats?.gif?.url ?? '',
      }));
      setResults(gifs);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TextInput
            style={styles.input}
            placeholder="Search GIFs..."
            placeholderTextColor="#555"
            value={query}
            onChangeText={(t) => { setQuery(t); search(t); }}
            autoFocus
          />
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <X size={18} color="#888" />
          </TouchableOpacity>
        </View>

        {loading && <ActivityIndicator color="#3b82f6" style={{ marginTop: 20 }} />}

        <FlatList
          data={results}
          numColumns={2}
          keyExtractor={(g) => g.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.cell}
              onPress={() => { onSelect(item.url); onClose(); }}
            >
              <Image source={{ uri: item.preview }} style={styles.gif} resizeMode="cover" />
            </TouchableOpacity>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: { flexDirection: 'row', padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  input: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, color: '#fff', fontSize: 15 },
  closeBtn: { justifyContent: 'center', paddingHorizontal: 8 },
  closeText: { color: '#888', fontSize: 20 },
  cell: { flex: 1, margin: 4 },
  gif: { width: '100%', aspectRatio: 1, borderRadius: 6, backgroundColor: '#1a1a1a' },
});

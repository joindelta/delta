import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, TextInput, ScrollView } from 'react-native';
import ActionSheet, { SheetManager } from 'react-native-actions-sheet';
import { BlobImage } from '../components/BlobImage';
import { STANDARD_EMOJI } from '../data/emoji';

interface EmojiPickerSheetProps {
  sheetId: string;
  payload?: {
    customEmojis?: Record<string, { blobId: string; mimeType: string; roomId: string | null }>;
    onSelect?: (emoji: string) => void;
  };
}

export function EmojiPickerSheet(props: EmojiPickerSheetProps) {
  const { customEmojis = {}, onSelect } = props.payload || {};
  const [query, setQuery] = useState('');

  const customItems = useMemo(
    () => Object.entries(customEmojis).map(([code, data]) => ({ code, data })),
    [customEmojis],
  );

  const filteredCustom = useMemo(() => {
    if (!query.trim()) return customItems;
    const q = query.trim().toLowerCase();
    return customItems.filter(item => item.code.toLowerCase().includes(q));
  }, [customItems, query]);

  const filteredStandard = useMemo(() => {
    if (!query.trim()) return STANDARD_EMOJI;
    const q = query.trim().toLowerCase();
    return STANDARD_EMOJI.filter(item => item.code.toLowerCase().includes(q));
  }, [query]);

  function selectEmoji(value: string) {
    SheetManager.hide(props.sheetId);
    onSelect?.(value);
  }

  return (
    <ActionSheet id={props.sheetId} containerStyle={styles.sheet} gestureEnabled>
      <View style={styles.header}>
        <Text style={styles.title}>Pick an emoji</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search :shortcode:"
          placeholderTextColor="#666"
          style={styles.search}
          autoCapitalize="none"
        />
      </View>
      <ScrollView contentContainerStyle={styles.grid}>
        {filteredCustom.map(item => (
          <TouchableOpacity
            key={item.code}
            style={styles.emojiBtn}
            onPress={() => selectEmoji(item.code)}
          >
            <BlobImage
              blobHash={item.data.blobId}
              mimeType={item.data.mimeType}
              roomId={item.data.roomId}
              style={styles.customEmojiImg}
            />
          </TouchableOpacity>
        ))}
        {filteredStandard.map(item => (
          <TouchableOpacity
            key={item.code}
            style={styles.emojiBtn}
            onPress={() => selectEmoji(item.emoji)}
          >
            <Text style={styles.emojiText}>{item.emoji}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </ActionSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 12,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    gap: 8,
  },
  title: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
  search: {
    backgroundColor: '#1b1b1b',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#fff',
    fontSize: 14,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 16,
  },
  emojiBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#1b1b1b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiText: { fontSize: 20 },
  customEmojiImg: { width: 22, height: 22, borderRadius: 4 },
});


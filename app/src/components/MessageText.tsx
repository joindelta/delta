import React from 'react';
import { Text, Linking, StyleSheet, View } from 'react-native';
import { BlobImage } from './BlobImage';
import { STANDARD_EMOJI_BY_CODE } from '../data/emoji';

// Combined regex: URLs first, then @mentions, then #channels
// URL regex uses greedy matching to capture full URLs
const TOKEN_RE = /(https?:\/\/[^\s]+)(?=[.,!?)">\s]|$)|@([\w+-]+)|#([\w+-]+)/g;

type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'url'; content: string }
  | { kind: 'mention'; content: string }
  | { kind: 'channel'; content: string };

export function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ kind: 'text', content: text.slice(last, m.index) });
    }
    if (m[1]) {
      segments.push({ kind: 'url', content: m[1] });
    } else if (m[2]) {
      segments.push({ kind: 'mention', content: '@' + m[2] });
    } else if (m[3]) {
      segments.push({ kind: 'channel', content: '#' + m[3] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ kind: 'text', content: text.slice(last) });
  }
  return segments;
}

/** Extract all URLs from a string (used for link previews). */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m[1]) urls.push(m[1]);
  }
  return urls;
}

/** Extract all @mentions from a string (returns usernames without the @). */
export function extractMentions(text: string): string[] {
  const mentions: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m[2]) mentions.push(m[2]);
  }
  return Array.from(new Set(mentions));
}

interface Props {
  text: string;
  baseStyle?: object;
  customEmojis?: Record<string, { blobId: string; mimeType: string; roomId: string | null }>;
}

export function MessageText({ text, baseStyle, customEmojis = {} }: Props) {
  const segments = parseSegments(text);
  const emojiTokenRe = /(:[a-zA-Z0-9_+-]+:)/g;
  return (
    <View style={[styles.base, baseStyle]}>
      {segments.flatMap((seg, i) => {
        switch (seg.kind) {
          case 'url':
            return (
              <Text
                key={i}
                style={styles.link}
                onPress={() => Linking.openURL(seg.content)}
                suppressHighlighting
              >
                {seg.content}
              </Text>
            );
          case 'mention':
            return (
              <Text key={i} style={styles.mention}>
                {seg.content}
              </Text>
            );
          case 'channel':
            return (
              <Text key={i} style={styles.channel}>
                {seg.content}
              </Text>
            );
          default:
            if (!seg.content) return null;
            return seg.content.split(emojiTokenRe).map((part, j) => {
              if (part.startsWith(':') && part.endsWith(':') && customEmojis[part]) {
                const emoji = customEmojis[part];
                return (
                  <View key={`${i}-${j}`} style={styles.inlineEmoji}>
                    <BlobImage
                      blobHash={emoji.blobId}
                      mimeType={emoji.mimeType}
                      roomId={emoji.roomId}
                      style={styles.inlineEmojiImg}
                    />
                  </View>
                );
              }
              if (part.startsWith(':') && part.endsWith(':') && STANDARD_EMOJI_BY_CODE[part]) {
                return (
                  <Text key={`${i}-${j}`} style={styles.text}>
                    {STANDARD_EMOJI_BY_CODE[part]}
                  </Text>
                );
              }
              return (
                <Text key={`${i}-${j}`} style={styles.text}>
                  {part}
                </Text>
              );
            });
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    flexShrink: 1,
  },
  text: {
    color: '#dcddde',
    fontSize: 15,
    lineHeight: 21,
  },
  link: {
    color: '#00AFF4',
    textDecorationLine: 'underline',
    fontSize: 15,
    lineHeight: 21,
  },
  mention: {
    color: '#c9cdfb',
    backgroundColor: 'rgba(88, 101, 242, 0.25)',
    borderRadius: 3,
    fontWeight: '600',
    fontSize: 15,
    lineHeight: 21,
  },
  channel: {
    color: '#5865F2',
    fontWeight: '600',
    fontSize: 15,
    lineHeight: 21,
  },
  inlineEmoji: { marginHorizontal: 2 },
  inlineEmojiImg: { width: 18, height: 18, borderRadius: 4 },
});

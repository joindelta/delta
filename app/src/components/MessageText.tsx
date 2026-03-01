import React from 'react';
import { Text, Linking, StyleSheet } from 'react-native';

// Combined regex: URLs first (greedy), then @mentions, then #channels
const TOKEN_RE = /(https?:\/\/\S+?)(?=[.,!?)>\s]|$)|@(\w+)|#([\w-]+)/g;

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

interface Props {
  text: string;
  baseStyle?: object;
}

export function MessageText({ text, baseStyle }: Props) {
  const segments = parseSegments(text);
  return (
    <Text style={[styles.base, baseStyle]}>
      {segments.map((seg, i) => {
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
            return <Text key={i}>{seg.content}</Text>;
        }
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    color: '#dcddde',
    fontSize: 15,
    lineHeight: 21,
    flexShrink: 1,
  },
  link: {
    color: '#00AFF4',
    textDecorationLine: 'underline',
  },
  mention: {
    color: '#c9cdfb',
    backgroundColor: 'rgba(88, 101, 242, 0.25)',
    borderRadius: 3,
    fontWeight: '600',
  },
  channel: {
    color: '#5865F2',
    fontWeight: '600',
  },
});

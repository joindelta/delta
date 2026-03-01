import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  Linking,
  ActivityIndicator,
} from 'react-native';

interface OgData {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

function getMeta(html: string, property: string): string | undefined {
  // Matches both orderings of property/content attributes
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'))?.[1]
  );
}

function getMetaName(html: string, name: string): string | undefined {
  return (
    html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'))?.[1]
  );
}

function resolveUrl(url: string, base: string): string {
  if (!url) return url;
  if (url.startsWith('http')) return url;
  try {
    const origin = new URL(base).origin;
    return url.startsWith('/') ? `${origin}${url}` : `${origin}/${url}`;
  } catch {
    return url;
  }
}

function parseOg(html: string, pageUrl: string): OgData {
  const title =
    getMeta(html, 'og:title') ??
    getMetaName(html, 'twitter:title') ??
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();

  const description =
    getMeta(html, 'og:description') ??
    getMetaName(html, 'twitter:description') ??
    getMetaName(html, 'description');

  const rawImage =
    getMeta(html, 'og:image') ??
    getMetaName(html, 'twitter:image') ??
    getMetaName(html, 'twitter:image:src');
  const image = rawImage ? resolveUrl(rawImage, pageUrl) : undefined;

  let siteName: string | undefined;
  try {
    siteName = getMeta(html, 'og:site_name') ?? new URL(pageUrl).hostname;
  } catch {
    siteName = undefined;
  }

  const faviconMatch =
    html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i)?.[1];
  const favicon = faviconMatch ? resolveUrl(faviconMatch, pageUrl) : undefined;

  return { title, description, image, siteName, favicon };
}

// Simple in-memory cache keyed by URL
const ogCache: Record<string, OgData | null> = {};

interface Props {
  url: string;
}

export function LinkPreview({ url }: Props) {
  const cached = Object.prototype.hasOwnProperty.call(ogCache, url) ? ogCache[url] : undefined;
  const [data, setData] = useState<OgData | null>(cached ?? null);
  const [loading, setLoading] = useState(cached === undefined);

  useEffect(() => {
    if (cached !== undefined) return;

    let cancelled = false;
    setLoading(true);

    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; facebookexternalhit/1.1)',
        'Accept': 'text/html',
      },
    })
      .then(res => res.text())
      .then(html => {
        if (cancelled) return;
        const og = parseOg(html, url);
        const result = og.title || og.image ? og : null;
        ogCache[url] = result;
        setData(result);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          ogCache[url] = null;
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, cached]);

  if (loading) {
    return (
      <View style={styles.skeleton}>
        <View style={styles.accent} />
        <ActivityIndicator size="small" color="#555" style={{ margin: 12 }} />
      </View>
    );
  }

  if (!data) return null;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => Linking.openURL(url)}
      activeOpacity={0.8}
    >
      <View style={styles.accent} />
      <View style={styles.body}>
        {/* Site name row with favicon */}
        {data.siteName && (
          <View style={styles.siteRow}>
            {data.favicon ? (
              <Image
                source={{ uri: data.favicon }}
                style={styles.favicon}
                onError={() => {}}
              />
            ) : null}
            <Text style={styles.siteName} numberOfLines={1}>
              {data.siteName}
            </Text>
          </View>
        )}

        {/* Title */}
        {data.title ? (
          <Text style={styles.title} numberOfLines={2}>
            {data.title}
          </Text>
        ) : null}

        {/* Description */}
        {data.description ? (
          <Text style={styles.description} numberOfLines={3}>
            {data.description}
          </Text>
        ) : null}

        {/* Preview image */}
        {data.image ? (
          <Image
            source={{ uri: data.image }}
            style={styles.previewImage}
            resizeMode="cover"
            onError={() => {}}
          />
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: '#2b2d31',
    borderRadius: 4,
    marginTop: 6,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  skeleton: {
    flexDirection: 'row',
    backgroundColor: '#2b2d31',
    borderRadius: 4,
    marginTop: 6,
    overflow: 'hidden',
  },
  accent: {
    width: 4,
    backgroundColor: '#1d9bd1',
  },
  body: {
    flex: 1,
    padding: 10,
    gap: 4,
  },
  siteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  favicon: {
    width: 16,
    height: 16,
    borderRadius: 2,
  },
  siteName: {
    color: '#888',
    fontSize: 12,
  },
  title: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  description: {
    color: '#b5bac1',
    fontSize: 13,
    lineHeight: 18,
  },
  previewImage: {
    width: '100%',
    height: 200,
    borderRadius: 4,
    marginTop: 6,
    backgroundColor: '#1e1f22',
  },
});

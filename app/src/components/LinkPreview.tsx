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
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag =
    html.match(new RegExp(`<meta[^>]*\\bproperty\\s*=\\s*["']?${escaped}["']?[^>]*>`, 'i')) ??
    html.match(new RegExp(`<meta[^>]*\\bcontent\\s*=\\s*["'][^"']+["'][^>]*\\bproperty\\s*=\\s*["']?${escaped}["']?[^>]*>`, 'i'));
  if (!tag) return undefined;
  return tag[0].match(/\bcontent\s*=\s*["']?([^"'>]+)["']?/i)?.[1];
}

function getMetaName(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag =
    html.match(new RegExp(`<meta[^>]*\\bname\\s*=\\s*["']?${escaped}["']?[^>]*>`, 'i')) ??
    html.match(new RegExp(`<meta[^>]*\\bcontent\\s*=\\s*["'][^"']+["'][^>]*\\bname\\s*=\\s*["']?${escaped}["']?[^>]*>`, 'i'));
  if (!tag) return undefined;
  return tag[0].match(/\bcontent\s*=\s*["']?([^"'>]+)["']?/i)?.[1];
}

function resolveUrl(url: string, base: string): string {
  if (!url) return url;
  if (url.startsWith('http') || url.startsWith('data:')) return url;
  try {
    const baseUrl = new URL(base);
    if (url.startsWith('//')) return `${baseUrl.protocol}${url}`;
    const origin = baseUrl.origin;
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
    getMeta(html, 'og:image:secure_url') ??
    getMeta(html, 'og:image:url') ??
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
        const result = og.title || og.image || og.description ? og : null;
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

  // Show a basic link card even if no OG data (so the link isn't invisible)
  const hostname = new URL(url).hostname;
  // If siteName is just a subdomain prefix like "www", use full hostname
  const siteName = data?.siteName && !['www', 'm', 'mobile'].includes(data.siteName.toLowerCase())
    ? data.siteName
    : hostname;
  const displayData = data ? { ...data, siteName } : { siteName: hostname };

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => Linking.openURL(url)}
      activeOpacity={0.8}
    >
      <View style={styles.accent} />
      <View style={styles.body}>
        {/* Site name row with favicon */}
        {displayData.siteName && (
          <View style={styles.siteRow}>
            {displayData.favicon ? (
              <Image
                source={{ uri: displayData.favicon }}
                style={styles.favicon}
                onError={() => {}}
              />
            ) : null}
            <Text style={styles.siteName} numberOfLines={1}>
              {displayData.siteName}
            </Text>
          </View>
        )}

        {/* Title */}
        {displayData.title ? (
          <Text style={styles.title} numberOfLines={2}>
            {displayData.title}
          </Text>
        ) : null}

        {/* Description */}
        {displayData.description ? (
          <Text style={styles.description} numberOfLines={3}>
            {displayData.description}
          </Text>
        ) : null}

        {/* Preview image */}
        {displayData.image ? (
          <Image
            source={{ uri: displayData.image }}
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
    width: '100%',
    maxWidth: 400,
    alignSelf: 'flex-start',
  },
  skeleton: {
    flexDirection: 'row',
    backgroundColor: '#2b2d31',
    borderRadius: 4,
    marginTop: 6,
    overflow: 'hidden',
    width: '100%',
    maxWidth: 400,
    alignSelf: 'flex-start',
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

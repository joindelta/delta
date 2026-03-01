import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Clipboard,
  Share,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';

// Enable LayoutAnimation for Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  pkarrUrl: string;
  publicKeyHex: string;
  label: string;
  onShare?: () => void;
}

export function PublicIdentityCard({ pkarrUrl, publicKeyHex, label, onShare }: Props) {
  const [showFullKey, setShowFullKey] = useState(false);
  const [dnsExpanded, setDnsExpanded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const truncatedKey = `${publicKeyHex.slice(0, 16)}...${publicKeyHex.slice(-8)}`;

  const handleCopy = (text: string, type: string) => {
    Clipboard.setString(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleShare = async () => {
    if (onShare) {
      onShare();
      return;
    }
    try {
      await Share.share({
        message: `${label}: ${pkarrUrl}`,
        url: pkarrUrl,
      });
    } catch {
      // Share cancelled
    }
  };

  const toggleDns = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDnsExpanded(!dnsExpanded);
  };

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.iconContainer}>
          <Text style={s.icon}>🌐</Text>
        </View>
        <View style={s.headerText}>
          <Text style={s.title}>{label}</Text>
          <Text style={s.subtitle}>Public on DHT</Text>
        </View>
      </View>

      {/* QR Code */}
      <View style={s.qrContainer}>
        <QRCode
          value={pkarrUrl}
          size={160}
          backgroundColor="#111"
          color="#fff"
        />
      </View>

      {/* Pkarr URL */}
      <View style={s.row}>
        <View style={s.rowContent}>
          <Text style={s.rowLabel}>Your Public URL</Text>
          <Text style={s.rowValue} numberOfLines={1} ellipsizeMode="middle">
            {pkarrUrl}
          </Text>
        </View>
        <View style={s.rowActions}>
          <TouchableOpacity
            style={s.iconBtn}
            onPress={() => handleCopy(pkarrUrl, 'url')}
          >
            <Text style={s.iconBtnText}>
              {copied === 'url' ? '✓' : '📋'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Public Key */}
      <TouchableOpacity
        style={s.row}
        onPress={() => setShowFullKey(!showFullKey)}
        activeOpacity={0.7}
      >
        <View style={s.rowContent}>
          <Text style={s.rowLabel}>Public Key</Text>
          <Text style={s.rowValue} numberOfLines={showFullKey ? undefined : 1}>
            {showFullKey ? publicKeyHex : truncatedKey}
          </Text>
        </View>
        <View style={s.rowActions}>
          <TouchableOpacity
            style={s.iconBtn}
            onPress={() => handleCopy(publicKeyHex, 'key')}
          >
            <Text style={s.iconBtnText}>
              {copied === 'key' ? '✓' : '📋'}
            </Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

      {/* Share Button */}
      <TouchableOpacity style={s.shareBtn} onPress={handleShare}>
        <Text style={s.shareBtnText}>Share Public Link</Text>
      </TouchableOpacity>

      {/* DNS Configuration - Expandable */}
      <TouchableOpacity style={s.dnsHeader} onPress={toggleDns} activeOpacity={0.7}>
        <Text style={s.dnsHeaderText}>DNS Configuration (optional)</Text>
        <Text style={s.dnsHeaderIcon}>{dnsExpanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {dnsExpanded && (
        <View style={s.dnsContent}>
          <Text style={s.dnsText}>
            To use a custom domain, add this TXT record to your DNS:
          </Text>
          
          <View style={s.dnsRecord}>
            <View style={s.dnsRow}>
              <Text style={s.dnsLabel}>Host:</Text>
              <Text style={s.dnsValue}>_delta</Text>
            </View>
            <View style={s.dnsRow}>
              <Text style={s.dnsLabel}>Value:</Text>
              <Text style={s.dnsValue} numberOfLines={2} ellipsizeMode="middle">
                {pkarrUrl}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={s.copyDnsBtn}
            onPress={() => handleCopy(`Host: _delta\nValue: ${pkarrUrl}`, 'dns')}
          >
            <Text style={s.copyDnsText}>
              {copied === 'dns' ? 'Copied!' : 'Copy Record'}
            </Text>
          </TouchableOpacity>

          <Text style={s.dnsHelp}>
            Delta-enabled apps can then resolve you at yourdomain.com
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    marginVertical: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1e1e1e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 20,
  },
  headerText: {
    marginLeft: 12,
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  subtitle: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
  qrContainer: {
    alignItems: 'center',
    paddingVertical: 20,
    backgroundColor: '#0a0a0a',
    borderRadius: 12,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  rowContent: {
    flex: 1,
  },
  rowLabel: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: {
    color: '#fff',
    fontSize: 13,
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  rowActions: {
    flexDirection: 'row',
    marginLeft: 8,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1e1e1e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: {
    fontSize: 16,
  },
  shareBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  shareBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  dnsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  dnsHeaderText: {
    color: '#888',
    fontSize: 13,
  },
  dnsHeaderIcon: {
    color: '#666',
    fontSize: 12,
  },
  dnsContent: {
    paddingTop: 8,
  },
  dnsText: {
    color: '#666',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 12,
  },
  dnsRecord: {
    backgroundColor: '#0a0a0a',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  dnsRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  dnsLabel: {
    color: '#666',
    fontSize: 12,
    width: 50,
  },
  dnsValue: {
    color: '#fff',
    fontSize: 12,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  copyDnsBtn: {
    backgroundColor: '#1e1e1e',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
    marginBottom: 12,
  },
  copyDnsText: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
  },
  dnsHelp: {
    color: '#555',
    fontSize: 11,
    fontStyle: 'italic',
  },
});

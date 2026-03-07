import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
} from 'react-native';
import { useAuthStore } from '../stores/useAuthStore';
import { getConnectionStatus, getMyProfile, getNodeId, initNetwork, isNetworkInitialized } from '../ffi/gardensCore';
import type { ConnectionStatus } from '../ffi/gardensCore';

export function DebugConnectionPanel() {
  const [visible, setVisible] = useState(false);
  const { keypair } = useAuthStore();

  const [coreStatus, setCoreStatus] = useState<ConnectionStatus>('Offline');
  const [nodeId, setNodeId] = useState<string>('');
  const [networkReady, setNetworkReady] = useState<boolean>(false);
  const [profile, setProfile] = useState<{ publicKey: string; username: string } | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const statusResult = await getConnectionStatus();
        if (active) setCoreStatus(statusResult);
      } catch {
        if (active) setCoreStatus('Offline');
      }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (visible) {
      refreshDebugInfo();
    }
  }, [visible]);

  async function refreshDebugInfo() {
    try {
      const [statusResult, profResult, nodeResult, readyResult] = await Promise.all([
        getConnectionStatus(),
        getMyProfile(),
        getNodeId().catch(() => ''),
        isNetworkInitialized().catch(() => false),
      ]);
      setCoreStatus(statusResult);
      setNodeId(nodeResult);
      setNetworkReady(readyResult);
      setProfile(profResult ? { publicKey: profResult.publicKey, username: profResult.username } : null);
      setInitError(null);
      setLastRefresh(new Date());
    } catch (err: any) {
      console.error('Failed to fetch debug info:', err);
      setInitError(err?.message || 'Failed to fetch debug info');
    }
  }

  async function handleInitNetwork() {
    setInitError(null);
    try {
      await initNetwork(null);
      await refreshDebugInfo();
    } catch (err: any) {
      console.error('Failed to initialize network:', err);
      setInitError(err?.message || 'Failed to initialize network');
    }
  }

  function getStatusColor(s: ConnectionStatus): string {
    switch (s) {
      case 'Online': return '#22c55e';
      case 'Connecting': return '#f59e0b';
      case 'Offline': return '#6b7280';
      default: return '#6b7280';
    }
  }

  const needsInit = !networkReady;

  return (
    <>
      <TouchableOpacity onPress={() => setVisible(true)}>
        <View style={badgeStyles.badge}>
          <View style={[badgeStyles.dot, { backgroundColor: getStatusColor(coreStatus) }]} />
          <Text style={badgeStyles.text}>{coreStatus}</Text>
        </View>
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={() => setVisible(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.panel}>
            <View style={styles.header}>
              <Text style={styles.title}>Connection Debug</Text>
              <TouchableOpacity onPress={() => setVisible(false)}>
                <Text style={styles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.content}>
              {/* Initialize Network Button - Prominent if needed */}
              {needsInit && (
                <View style={styles.initSection}>
                  <TouchableOpacity
                    style={styles.initBtn}
                    onPress={handleInitNetwork}
                  >
                    <Text style={styles.initBtnText}>🚀 Start Network</Text>
                  </TouchableOpacity>
                  <Text style={styles.initHelp}>
                    Initialize Iroh P2P networking
                  </Text>
                </View>
              )}

              {initError && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>❌ {initError}</Text>
                </View>
              )}

              {/* Status Summary */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Status Summary</Text>
                <View style={styles.row}>
                  <Text style={styles.label}>Core Status:</Text>
                  <Text style={[styles.value, { color: getStatusColor(coreStatus) }]}>{coreStatus}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.label}>Last Updated:</Text>
                  <Text style={styles.value}>{lastRefresh.toLocaleTimeString()}</Text>
                </View>
              </View>

              {/* Network Info */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Network</Text>
                <View style={styles.row}>
                  <Text style={styles.label}>Initialized:</Text>
                  <Text style={styles.value}>{networkReady ? 'Yes' : 'No'}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.label}>Node ID:</Text>
                  <Text style={[styles.value, styles.code]} numberOfLines={1}>
                    {nodeId || 'Unavailable'}
                  </Text>
                </View>
              </View>

              {/* Identity */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Identity</Text>
                <View style={styles.row}>
                  <Text style={styles.label}>Public Key:</Text>
                  <Text style={[styles.value, styles.code]} numberOfLines={1}>
                    {keypair?.publicKeyHex.slice(0, 20)}...
                  </Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.label}>Username:</Text>
                  <Text style={styles.value}>{profile?.username || 'Not set'}</Text>
                </View>
              </View>

              {/* Actions */}
              <TouchableOpacity
                style={styles.refreshBtn}
                onPress={refreshDebugInfo}
              >
                <Text style={styles.refreshBtnText}>↻ Refresh Debug Info</Text>
              </TouchableOpacity>

              <View style={styles.spacer} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 4,
  },
  text: {
    fontSize: 12,
    fontWeight: '500',
    color: '#e5e7eb',
  },
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  panel: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    minHeight: '50%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  closeBtn: {
    color: '#888',
    fontSize: 24,
    padding: 4,
  },
  content: {
    padding: 16,
  },
  initSection: {
    marginBottom: 20,
    padding: 16,
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.3)',
  },
  initBtn: {
    backgroundColor: '#F2E58F',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  initBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '700',
  },
  initHelp: {
    color: '#888',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  label: {
    color: '#aaa',
    fontSize: 14,
  },
  value: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
    textAlign: 'right',
    marginLeft: 8,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  emptyText: {
    color: '#666',
    fontSize: 14,
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  warningBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  warningText: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '600',
  },
  helpText: {
    color: '#888',
    fontSize: 12,
    marginTop: 4,
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  refreshBtn: {
    backgroundColor: '#333',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  refreshBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  spacer: {
    height: 40,
  },
});

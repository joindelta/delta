import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { resolvePkarr } from '../ffi/deltaCore';
import { BlobImage } from '../components/BlobImage';

interface Props {
  visible: boolean;
  pkarrUrl: string;
  onClose: () => void;
}

export function CommunityPreviewSheet({ visible, pkarrUrl, onClose }: Props) {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orgData, setOrgData] = useState<{
    name: string;
    description: string | null;
    avatarBlobId: string | null;
    coverBlobId: string | null;
    publicKey: string;
  } | null>(null);

  const loadOrgData = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Parse pkarr URL: pk:<z32-key>
      const z32Key = pkarrUrl.replace('pk:', '');
      if (!z32Key) {
        setError('Invalid pkarr URL');
        setLoading(false);
        return;
      }

      const record = await resolvePkarr(z32Key);
      
      if (!record) {
        setError('Organization not found on DHT');
        setLoading(false);
        return;
      }

      if (record.recordType !== 'org') {
        setError('This link is not for an organization');
        setLoading(false);
        return;
      }

      setOrgData({
        name: record.name || 'Unknown Organization',
        description: record.description,
        avatarBlobId: record.avatarBlobId,
        coverBlobId: record.coverBlobId,
        publicKey: record.publicKey,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load organization');
    } finally {
      setLoading(false);
    }
  }, [pkarrUrl]);

  useEffect(() => {
    if (visible && pkarrUrl) {
      loadOrgData();
    }
  }, [visible, pkarrUrl, loadOrgData]);

  const handleJoin = () => {
    if (!orgData) return;
    
    // For now, just show an alert
    // In the future, this would send a join request to the org
    Alert.alert(
      'Request to Join',
      `Send a join request to ${orgData.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Request to Join', 
          onPress: () => {
            Alert.alert('Sent!', 'Your join request has been sent to the organization admins.');
            onClose();
          }
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={s.overlay}>
        <TouchableOpacity style={s.backdrop} onPress={onClose} />
        
        <View style={s.sheet}>
          <View style={s.handle} />
          
          {loading ? (
            <View style={s.center}>
              <ActivityIndicator color="#fff" size="large" />
              <Text style={s.loadingText}>Loading community...</Text>
            </View>
          ) : error ? (
            <View style={s.center}>
              <Text style={s.errorIcon}>⚠️</Text>
              <Text style={s.errorText}>{error}</Text>
              <TouchableOpacity style={s.retryBtn} onPress={loadOrgData}>
                <Text style={s.retryBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : orgData ? (
            <>
              {/* Cover Image */}
              <View style={s.coverContainer}>
                {orgData.coverBlobId ? (
                  <BlobImage blobHash={orgData.coverBlobId} style={s.coverImage} />
                ) : (
                  <View style={[s.coverImage, s.coverPlaceholder]}>
                    <Text style={s.coverPlaceholderText}>🌐</Text>
                  </View>
                )}
                
                {/* Avatar */}
                <View style={s.avatarContainer}>
                  {orgData.avatarBlobId ? (
                    <BlobImage blobHash={orgData.avatarBlobId} style={s.avatar} />
                  ) : (
                    <View style={[s.avatar, s.avatarPlaceholder]}>
                      <Text style={s.avatarText}>
                        {orgData.name.slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
              </View>

              {/* Org Info */}
              <View style={s.infoContainer}>
                <Text style={s.name}>{orgData.name}</Text>
                
                {orgData.description && (
                  <Text style={s.description}>{orgData.description}</Text>
                )}

                <View style={s.metaContainer}>
                  <View style={s.metaItem}>
                    <Text style={s.metaLabel}>Public Key</Text>
                    <Text style={s.metaValue} numberOfLines={1} ellipsizeMode="middle">
                      {orgData.publicKey}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Action Buttons */}
              <View style={s.actions}>
                <TouchableOpacity style={s.joinBtn} onPress={handleJoin}>
                  <Text style={s.joinBtnText}>Request to Join</Text>
                </TouchableOpacity>
                
                <TouchableOpacity style={s.closeBtn} onPress={onClose}>
                  <Text style={s.closeBtnText}>Close</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
  },
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 40,
    maxHeight: '80%',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#333',
    borderRadius: 2,
    alignSelf: 'center',
    marginVertical: 12,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  loadingText: {
    color: '#888',
    fontSize: 14,
    marginTop: 16,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryBtn: {
    backgroundColor: '#1e1e1e',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  coverContainer: {
    height: 140,
    marginBottom: 40,
    position: 'relative',
  },
  coverImage: {
    width: '100%',
    height: 140,
    borderRadius: 12,
  },
  coverPlaceholder: {
    backgroundColor: '#1e1e1e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverPlaceholderText: {
    fontSize: 48,
  },
  avatarContainer: {
    position: 'absolute',
    bottom: -30,
    left: 20,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 4,
    borderColor: '#111',
  },
  avatarPlaceholder: {
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
  },
  infoContainer: {
    paddingTop: 8,
  },
  name: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  description: {
    color: '#888',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  metaContainer: {
    backgroundColor: '#0a0a0a',
    borderRadius: 8,
    padding: 12,
    marginBottom: 24,
  },
  metaItem: {
    marginBottom: 8,
  },
  metaLabel: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  metaValue: {
    color: '#888',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  actions: {
    gap: 12,
  },
  joinBtn: {
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  joinBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  closeBtn: {
    backgroundColor: '#1e1e1e',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  closeBtnText: {
    color: '#888',
    fontSize: 16,
  },
});

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import type { OrgSummary } from '../ffi/deltaCore';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNative(): any {
  try { return require('delta_core'); } catch { return null; }
}

export function DiscoverOrgsScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    const native = getNative();
    if (!native || !query.trim()) return;
    setLoading(true);
    setSearched(false);
    try {
      const orgs: OrgSummary[] = await native.searchPublicOrgs(query.trim());
      setResults(orgs);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }

  function handleJoin(_org: OrgSummary) {
    Alert.alert('Coming soon', 'Joining orgs will be available in Phase 5.');
  }

  return (
    <View style={styles.root}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Search communities…"
          placeholderTextColor="#555"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.searchBtn} onPress={handleSearch}>
          <Text style={styles.searchBtnText}>Search</Text>
        </TouchableOpacity>
      </View>

      {loading && (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.hint}>Searching the network…</Text>
        </View>
      )}

      {!loading && searched && results.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.empty}>No communities found for "{query}"</Text>
          <Text style={styles.hint}>Try a different keyword, or check your connection.</Text>
        </View>
      )}

      <FlatList
        data={results}
        keyExtractor={item => item.orgId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardBody}>
              <Text style={styles.orgName}>{item.name}</Text>
              <Text style={styles.typeLabel}>{item.typeLabel}</Text>
              {item.description && (
                <Text style={styles.description} numberOfLines={2}>
                  {item.description}
                </Text>
              )}
            </View>
            <TouchableOpacity style={styles.joinBtn} onPress={() => handleJoin(item)}>
              <Text style={styles.joinBtnText}>Join</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },
  searchRow:   { flexDirection: 'row', margin: 16, gap: 8 },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 15,
  },
  searchBtn:     { backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  searchBtnText: { color: '#fff', fontWeight: '600' },
  center:        { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  empty:         { color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  hint:          { color: '#555', fontSize: 13, textAlign: 'center', marginTop: 8 },
  list:          { paddingHorizontal: 16, paddingBottom: 32 },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardBody:    { flex: 1 },
  orgName:     { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 2 },
  typeLabel:   { color: '#888', fontSize: 12, marginBottom: 4 },
  description: { color: '#aaa', fontSize: 13 },
  joinBtn:     { backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  joinBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});

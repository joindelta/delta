import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { X } from 'lucide-react-native';
import { useProfileStore } from '../stores/useProfileStore';
import { useAuthStore } from '../stores/useAuthStore';
import { createOrUpdateProfile } from '../ffi/gardensCore';
import { publishProfileMeta } from './LocationPickerSheet';

export const ALL_INTERESTS = [
  // ── Sexuality & Relationships ──────────────────────────────────────────────
  'BDSM', 'Bondage', 'Dominant', 'Submissive', 'Switch', 'Spanking',
  'Rope', 'Shibari', 'Leather', 'Latex', 'Wetting', 'ABDL', 'Diapers',
  'Age Play', 'Taboo', 'Incest', 'Voyeurism', 'Exhibitionism',
  'Cuckolding', 'Polyamory', 'Open Relationships', 'Swinging',
  'FemDom', 'MaleDom', 'Pet Play', 'Impact Play', 'Degradation',
  'Praise Kink', 'Sensory Play', 'Wax Play', 'Knife Play',
  'Chastity', 'Orgasm Control', 'Edging', 'Humiliation',
  'Furry', 'Vore', 'Tentacles', 'Hentai', 'OnlyFans', 'Sex Work',
  'Tantra', 'Casual Sex', 'Hookups', 'Dating', 'Monogamy',
  'Queer', 'Gay', 'Lesbian', 'Bisexual', 'Trans', 'Non-binary',
  'Asexual', 'Aromantic', 'Pansexual', 'Femboy', 'Crossdressing',

  // ── Privacy & Crypto ───────────────────────────────────────────────────────
  'Cryptography', 'Monero', 'Cashu', 'Bitcoin', 'Ethereum', 'Lightning Network',
  'Privacy Coins', 'Zcash', 'Tor', 'I2P', 'Darkweb', 'OPSEC',
  'Threat Modeling', 'Zero Knowledge Proofs', 'Self Custody', 'Cold Storage',
  'P2P Networks', 'Decentralization', 'Cypherpunk', 'PGP', 'Signal',
  'Open Source', 'Linux', 'Self Hosting', 'Homelab', 'VPNs',
  'Bug Bounty', 'CTF', 'Reverse Engineering', 'Exploit Development',

  // ── Politics & Activism ────────────────────────────────────────────────────
  'Anarchist', 'Leftist', 'Mutual Aid', 'Antifa', 'Libertarian',
  'Accelerationist', 'Eco-Anarchism', 'Communism', 'Socialism',
  'Syndicalism', 'Solarpunk', 'Degrowth', 'Land Back',
  'Abolition', 'Prison Reform', 'Drug Policy Reform', 'Sex Worker Rights',
  'Free Speech', 'Anti-Censorship', 'Whistleblowing', 'Leak Culture',
  'Counter Culture', 'Protest', 'Direct Action', 'Civil Disobedience',

  // ── Intelligence & SIGINT ──────────────────────────────────────────────────
  'SIGINT', 'OSINT', 'Radio Systems', 'Ham Radio', 'SDR',
  'Frequency Monitoring', 'Shortwave', 'Pirate Radio', 'Mesh Networking',
  'LoRa', 'Meshtastic', 'EMP Hardening', 'Faraday Cages',

  // ── Survival & Preparedness ────────────────────────────────────────────────
  'Foraging', 'Bushcraft', 'Prepping', 'Homesteading', 'Off Grid Living',
  'First Aid', 'Wilderness Medicine', 'Tactical Medicine', 'IFAK',
  'Guns', 'Firearms', 'Reloading', 'Suppressors', 'NFA Items',
  'Martial Arts', 'BJJ', 'MMA', 'Boxing', 'Wrestling', 'Krav Maga',
  'Knife Fighting', 'Archery', 'Hunting', 'Trapping', 'Fishing',
  'Water Purification', 'Fire Starting', 'Navigation', 'Land Surveying',
  'Herbalism', 'Permaculture', 'Seed Saving', 'Rainwater Harvesting',

  // ── Substances ─────────────────────────────────────────────────────────────
  'Cannabis', 'Psychedelics', 'Mushrooms', 'LSD', 'MDMA', 'DMT',
  'Ketamine', 'Harm Reduction', 'Drug Culture', 'Microdosing',
  'Kratom', 'Nootropics', 'Biohacking', 'Alcohol', 'Craft Beer',
  'Natural Wine', 'Whiskey', 'Sobriety', 'Sober Curious',

  // ── Tech & Hacking ─────────────────────────────────────────────────────────
  'Hacking', 'Red Team', 'Penetration Testing', 'Social Engineering',
  'Web3', 'Smart Contracts', 'NFTs', 'DAOs', 'DeFi',
  'AI', 'Machine Learning', 'LLMs', 'Robotics', 'Embedded Systems',
  'Rust', 'Go', 'Python', 'JavaScript', 'C', 'Assembly',
  '3D Printing', 'Electronics', 'Soldering', 'Arduino', 'Raspberry Pi',
  'Game Dev', 'Modding', 'Emulation', 'Retrocomputing',

  // ── Arts & Culture ─────────────────────────────────────────────────────────
  'Music', 'DJing', 'Music Production', 'Metal', 'Punk', 'Hip Hop',
  'Techno', 'Dark Ambient', 'Noise', 'Industrial', 'Black Metal',
  'Raves', 'Festivals', 'Burner Culture', 'Underground Parties',
  'Art', 'Graffiti', 'Street Art', 'Illustration', 'Tattoos',
  'Photography', 'Film', 'Zines', 'Poetry', 'Writing', 'Journalism',
  'Esoteric', 'Occult', 'Chaos Magick', 'Sigils', 'Tarot',
  'Astrology', 'Paganism', 'Satanism', 'LaVeyan',

  // ── Lifestyle ──────────────────────────────────────────────────────────────
  'Travel', 'Van Life', 'Nomad', 'Hiking', 'Rock Climbing',
  'Skateboarding', 'Surfing', 'Cycling', 'Running', 'Yoga',
  'Cooking', 'Fermentation', 'Veganism', 'Carnivore', 'Raw Diet',
  'Weightlifting', 'CrossFit', 'Calisthenics',
  'Reading', 'Philosophy', 'History', 'Economics', 'Psychology',
  'Gaming', 'Board Games', 'Dungeons & Dragons', 'LARP', 'Cosplay',
  'Anime', 'Manga', 'Comics', 'Sci-Fi', 'Horror', 'Dark Fiction',
  'Cats', 'Dogs', 'Reptiles', 'Insects', 'Birds',

  // ── Professional ───────────────────────────────────────────────────────────
  'Collaboration', 'Hiring', 'Consulting', 'Mentorship', 'Networking',
  'Investing', 'Venture Capital', 'Angel Investing', 'Startups',
  'Freelancing', 'Co-founding', 'Speaking', 'Research', 'Academia',
  'Community Building', 'Volunteering', 'Nonprofit',
];

const MAX_TAGS = 20;

export function InterestsSheet(props: SheetProps<'interests-sheet'>) {
  const { myProfile, fetchMyProfile } = useProfileStore();
  const { keypair } = useAuthStore();

  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  function onBeforeShow() {
    setTags(myProfile?.availableFor ?? []);
    setQuery('');
  }

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? ALL_INTERESTS.filter(i => i.toLowerCase().includes(q))
      : ALL_INTERESTS;
    return list.filter(i => !tags.includes(i));
  }, [query, tags]);

  function toggle(interest: string) {
    if (tags.includes(interest)) {
      setTags(tags.filter(t => t !== interest));
    } else {
      if (tags.length >= MAX_TAGS) {
        Alert.alert('Limit reached', `Maximum ${MAX_TAGS} interests.`);
        return;
      }
      setTags([...tags, interest]);
      setQuery('');
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await createOrUpdateProfile(
        myProfile?.username ?? '',
        myProfile?.bio ?? null,
        tags,
        myProfile?.isPublic ?? false,
        myProfile?.avatarBlobId ?? null,
        myProfile?.emailEnabled ?? false,
      );
      const publicKey = myProfile?.publicKey ?? keypair?.publicKeyHex;
      if (publicKey) publishProfileMeta(publicKey, { interests: tags });
      await fetchMyProfile();
      SheetManager.hide('interests-sheet');
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Failed to save interests');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionSheet
      id={props.sheetId}
      gestureEnabled={!saving}
      containerStyle={s.container}
      indicatorStyle={s.handle}
      onBeforeShow={onBeforeShow}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.closeBtn} onPress={() => SheetManager.hide('interests-sheet')}>
          <X size={20} color="#888" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Interests</Text>
        <TouchableOpacity
          style={[s.saveBtn, saving && s.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving
            ? <ActivityIndicator size="small" color="#000" />
            : <Text style={s.saveBtnText}>Save</Text>}
        </TouchableOpacity>
      </View>

      {/* Selected tags */}
      {tags.length > 0 && (
        <View style={s.selectedWrap}>
          <View style={s.selectedRow}>
            {tags.map(tag => (
              <TouchableOpacity key={tag} style={s.selectedTag} onPress={() => toggle(tag)}>
                <Text style={s.selectedTagText}>{tag}</Text>
                <X size={11} color="#fff" />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Search */}
      <View style={s.searchRow}>
        <TextInput
          style={s.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search interests..."
          placeholderTextColor="#555"
          autoCorrect={false}
          returnKeyType="done"
        />
      </View>

      {/* Suggestions */}
      <FlatList
        data={suggestions}
        keyExtractor={item => item}
        style={s.list}
        keyboardShouldPersistTaps="handled"
        numColumns={2}
        columnWrapperStyle={s.columnWrapper}
        contentContainerStyle={s.listContent}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={s.chip}
            onPress={() => toggle(item)}
            activeOpacity={0.7}
          >
            <Text style={s.chipText}>{item}</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <Text style={s.empty}>{query.trim() ? 'No matching interests.' : 'All interests already selected.'}</Text>
        }
      />

      <Text style={s.count}>{tags.length}/{MAX_TAGS} selected</Text>
    </ActionSheet>
  );
}

const s = StyleSheet.create({
  container: {
    backgroundColor: '#111',
    paddingHorizontal: 0,
    paddingBottom: 0,
    height: '85%',
  },
  handle: { backgroundColor: '#333' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  closeBtn: { padding: 4, width: 36 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  saveBtn: {
    backgroundColor: '#F2E58F',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#000', fontSize: 14, fontWeight: '600' },

  selectedWrap: {
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  selectedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  selectedTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#7c3aed',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  selectedTagText: { color: '#fff', fontSize: 13, fontWeight: '500' },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  search: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#333',
  },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 16 },
  columnWrapper: { gap: 8, marginBottom: 8 },
  chip: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    alignItems: 'center',
  },
  chipText: { color: '#ccc', fontSize: 13 },

  count: {
    color: '#444',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 10,
  },
  empty: { color: '#555', fontSize: 14, textAlign: 'center', paddingVertical: 32 },
});

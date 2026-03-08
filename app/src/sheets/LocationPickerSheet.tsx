import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { ChevronLeft, X, Check } from 'lucide-react-native';
import { GetCountries, GetState, GetCity } from 'react-country-state-city';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '../stores/useAuthStore';
import { useProfileStore } from '../stores/useProfileStore';
import { DEFAULT_RELAY_URL } from '../stores/useProfileStore';

export const LOCATION_STORAGE_KEY = '@gardens/location';

type Step = 'country' | 'state' | 'city';

interface Place { id: number; name: string; }

export async function publishProfileMeta(
  publicKey: string,
  patch: { loco?: string; interests?: string[] },
): Promise<void> {
  await fetch(`${DEFAULT_RELAY_URL}/profile-meta/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, meta: patch }),
  }).catch(() => {});
}

export function LocationPickerSheet(props: SheetProps<'location-picker-sheet'>) {
  const { keypair } = useAuthStore();
  const { myProfile } = useProfileStore();

  const [step, setStep] = useState<Step>('country');
  const [saving, setSaving] = useState(false);

  const [countries, setCountries] = useState<Place[]>([]);
  const [states, setStates] = useState<Place[]>([]);
  const [cities, setCities] = useState<Place[]>([]);

  const [selectedCountry, setSelectedCountry] = useState<Place | null>(null);
  const [selectedState, setSelectedState] = useState<Place | null>(null);
  const [selectedCity, setSelectedCity] = useState<Place | null>(null);

  useEffect(() => {
    GetCountries().then((list: any[]) =>
      setCountries(list.map(c => ({ id: c.id, name: c.name }))),
    );
  }, []);

  useEffect(() => {
    if (!selectedCountry) return;
    setStates([]);
    setCities([]);
    setSelectedState(null);
    setSelectedCity(null);
    GetState(selectedCountry.id).then((list: any[]) =>
      setStates(list.map(s => ({ id: s.id, name: s.name }))),
    );
  }, [selectedCountry]);

  useEffect(() => {
    if (!selectedCountry || !selectedState) return;
    setCities([]);
    setSelectedCity(null);
    GetCity(selectedCountry.id, selectedState.id).then((list: any[]) =>
      setCities(list.map(c => ({ id: c.id, name: c.name }))),
    );
  }, [selectedState]);

  function reset() {
    setStep('country');
    setSelectedCountry(null);
    setSelectedState(null);
    setSelectedCity(null);
    setStates([]);
    setCities([]);
  }

  function close() {
    SheetManager.hide('location-picker-sheet');
  }

  async function handleSave() {
    const country = selectedCountry?.name ?? '';
    const state = selectedState?.name ?? '';
    const city = selectedCity?.name ?? '';
    const loco = [country, state, city].filter(Boolean).join(', ');

    setSaving(true);
    try {
      await AsyncStorage.setItem(LOCATION_STORAGE_KEY, loco);
      const publicKey = myProfile?.publicKey ?? keypair?.publicKeyHex;
      if (publicKey) await publishProfileMeta(publicKey, { loco });
      close();
    } catch {
      Alert.alert('Error', 'Failed to save location');
    } finally {
      setSaving(false);
    }
  }

  const currentList: Place[] =
    step === 'country' ? countries :
    step === 'state'   ? states   : cities;

  const stepTitle = step === 'country' ? 'Country' : step === 'state' ? 'State / Region' : 'City';

  const canGoBack = step === 'state' || step === 'city';
  function goBack() {
    if (step === 'city') { setStep('state'); }
    else if (step === 'state') { setStep('country'); }
  }

  function selectPlace(place: Place) {
    if (step === 'country') {
      setSelectedCountry(place);
      setStep(states.length === 0 ? 'city' : 'state'); // skip state if none
      setStep('state');
    } else if (step === 'state') {
      setSelectedState(place);
      setStep('city');
    } else {
      setSelectedCity(place);
    }
  }

  const hasSelection = !!selectedCountry;
  const locationPreview = [selectedCity?.name, selectedState?.name, selectedCountry?.name]
    .filter(Boolean).join(', ');

  return (
    <ActionSheet
      id={props.sheetId}
      gestureEnabled={!saving}
      containerStyle={s.container}
      indicatorStyle={s.handle}
      onBeforeShow={reset}
    >
      {/* Header */}
      <View style={s.header}>
        {canGoBack ? (
          <TouchableOpacity style={s.headerBtn} onPress={goBack}>
            <ChevronLeft size={22} color="#888" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.headerBtn} onPress={close}>
            <X size={20} color="#888" />
          </TouchableOpacity>
        )}
        <Text style={s.headerTitle}>{stepTitle}</Text>
        <TouchableOpacity
          style={[s.saveBtn, (!hasSelection || saving) && s.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!hasSelection || saving}
        >
          {saving ? <ActivityIndicator size="small" color="#000" /> : <Text style={s.saveBtnText}>Save</Text>}
        </TouchableOpacity>
      </View>

      {/* Current selection preview */}
      {hasSelection && (
        <View style={s.preview}>
          <Check size={14} color="#4ade80" />
          <Text style={s.previewText} numberOfLines={1}>{locationPreview}</Text>
        </View>
      )}

      {/* List */}
      {currentList.length === 0 ? (
        <View style={s.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <FlatList
          data={currentList}
          keyExtractor={item => String(item.id)}
          style={s.list}
          renderItem={({ item }) => {
            const isSelected =
              (step === 'country' && selectedCountry?.id === item.id) ||
              (step === 'state'   && selectedState?.id   === item.id) ||
              (step === 'city'    && selectedCity?.id    === item.id);
            return (
              <TouchableOpacity
                style={[s.item, isSelected && s.itemSelected]}
                onPress={() => selectPlace(item)}
              >
                <Text style={[s.itemText, isSelected && s.itemTextSelected]}>{item.name}</Text>
                {isSelected && <Check size={16} color="#F2E58F" />}
              </TouchableOpacity>
            );
          }}
        />
      )}
    </ActionSheet>
  );
}

const s = StyleSheet.create({
  container: { backgroundColor: '#111', paddingHorizontal: 0, paddingBottom: 0, height: '80%' },
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
  headerBtn: { padding: 4, width: 36 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  saveBtn: { backgroundColor: '#F2E58F', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 16 },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: '#000', fontSize: 14, fontWeight: '600' },

  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#0d1a0d',
    borderBottomWidth: 1,
    borderBottomColor: '#1a2a1a',
  },
  previewText: { color: '#4ade80', fontSize: 13, flex: 1 },

  list: { flex: 1 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
  },
  itemSelected: { backgroundColor: '#1a1a0d' },
  itemText: { color: '#ddd', fontSize: 15 },
  itemTextSelected: { color: '#F2E58F', fontWeight: '600' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },
});

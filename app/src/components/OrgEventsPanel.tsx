import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  ScrollView,
  Alert,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Calendar, MapPin, Hash, Share2, Check, X, Pencil, Trash2 } from 'lucide-react-native';
import { createEvent, listEvents, listEventRsvps, setEventRsvp, clearEventRsvp, generateInviteToken, updateEvent, deleteEvent } from '../ffi/gardensCore';
import type { Event, EventRsvp, Room } from '../ffi/gardensCore';
import { useAuthStore } from '../stores/useAuthStore';
import { broadcastOp, useSyncStore } from '../stores/useSyncStore';

type Props = {
  orgId: string;
  orgName: string;
  rooms: Room[];
};

const RSVP_INTERESTED = 'interested';

function toDateInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toTimeInput(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function parseDateTime(dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export function OrgEventsPanel({ orgId, orgName, rooms }: Props) {
  const keypair = useAuthStore(s => s.keypair);
  const myKey = keypair?.publicKeyHex ?? '';

  const [events, setEvents] = useState<Event[]>([]);
  const [rsvps, setRsvps] = useState<Record<string, EventRsvp[]>>({});
  const [loading, setLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [createStep, setCreateStep] = useState(1);
  const [locationType, setLocationType] = useState<'room' | 'somewhere_else'>('room');
  const [locationRoomId, setLocationRoomId] = useState<string | null>(null);
  const [locationText, setLocationText] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [creating, setCreating] = useState(false);

  const [qrOpen, setQrOpen] = useState(false);
  const [qrToken, setQrToken] = useState<string | null>(null);

  const roomOptions = useMemo(() => rooms.filter(r => !r.isArchived), [rooms]);
  const { subscribe: syncSubscribe, unsubscribe: syncUnsubscribe, opTick } = useSyncStore();

  useEffect(() => {
    refresh();
    syncSubscribe(orgId);
    return () => syncUnsubscribe(orgId);
  }, [orgId]);

  // Re-fetch when an op arrives for this org's topic
  useEffect(() => {
    if (opTick > 0) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opTick]);

  async function refresh() {
    setLoading(true);
    try {
      const next = await listEvents(orgId);
      setEvents(next);
      const rsvpPairs = await Promise.all(
        next.map(async (ev) => [ev.eventId, await listEventRsvps(ev.eventId)] as const),
      );
      const nextMap: Record<string, EventRsvp[]> = {};
      rsvpPairs.forEach(([id, list]) => { nextMap[id] = list; });
      setRsvps(nextMap);
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    const now = new Date();
    const start = new Date(now.getTime() + 60 * 60 * 1000);
    const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    setLocationType('room');
    setLocationRoomId(roomOptions[0]?.roomId ?? null);
    setLocationText('');
    setTitle('');
    setDescription('');
    setStartDate(toDateInput(start));
    setStartTime(toTimeInput(start));
    setEndDate(toDateInput(end));
    setEndTime(toTimeInput(end));
    setCreateStep(1);
    setCreateOpen(true);
  }

  function openEdit(ev: Event) {
    const start = new Date(ev.startAt);
    const end = ev.endAt ? new Date(ev.endAt) : null;
    setLocationType((ev.locationType as 'room' | 'somewhere_else') ?? 'room');
    setLocationRoomId(ev.locationRoomId ?? roomOptions[0]?.roomId ?? null);
    setLocationText(ev.locationText ?? '');
    setTitle(ev.title ?? '');
    setDescription(ev.description ?? '');
    setStartDate(toDateInput(start));
    setStartTime(toTimeInput(start));
    setEndDate(end ? toDateInput(end) : toDateInput(start));
    setEndTime(end ? toTimeInput(end) : toTimeInput(start));
    setCreateStep(1);
    setEditEventId(ev.eventId);
    setCreateOpen(true);
  }

  async function handleCreateOrUpdate() {
    const start = parseDateTime(startDate, startTime);
    const end = parseDateTime(endDate, endTime);
    if (!title.trim()) {
      Alert.alert('Missing title', 'Please enter a title for the event.');
      return;
    }
    if (!start) {
      Alert.alert('Invalid start time', 'Please enter a valid start date and time.');
      return;
    }
    if (end && end < start) {
      Alert.alert('Invalid end time', 'End time must be after the start time.');
      return;
    }
    if (locationType === 'room' && !locationRoomId) {
      Alert.alert('Missing channel', 'Please select a channel.');
      return;
    }
    if (locationType === 'somewhere_else' && !locationText.trim()) {
      Alert.alert('Missing location', 'Please enter a location or link.');
      return;
    }

    setCreating(true);
    try {
      if (editEventId) {
        const result = await updateEvent(
          orgId,
          editEventId,
          title.trim(),
          description.trim() || null,
          locationType,
          locationType === 'somewhere_else' ? locationText.trim() : null,
          locationType === 'room' ? locationRoomId : null,
          start.getTime(),
          end ? end.getTime() : null,
        );
        broadcastOp(orgId, result.opBytes);
      } else {
        const result = await createEvent(
          orgId,
          title.trim(),
          description.trim() || null,
          locationType,
          locationType === 'somewhere_else' ? locationText.trim() : null,
          locationType === 'room' ? locationRoomId : null,
          start.getTime(),
          end ? end.getTime() : null,
        );
        broadcastOp(orgId, result.opBytes);
      }
      setCreateOpen(false);
      setEditEventId(null);
      await refresh();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to save event');
    } finally {
      setCreating(false);
    }
  }

  function adjustTime(which: 'start' | 'end', minutes: number) {
    const base = parseDateTime(which === 'start' ? startDate : endDate, which === 'start' ? startTime : endTime);
    if (!base) return;
    const next = new Date(base.getTime() + minutes * 60 * 1000);
    if (which === 'start') {
      setStartDate(toDateInput(next));
      setStartTime(toTimeInput(next));
    } else {
      setEndDate(toDateInput(next));
      setEndTime(toTimeInput(next));
    }
  }

  function adjustDate(which: 'start' | 'end', days: number) {
    const base = parseDateTime(which === 'start' ? startDate : endDate, which === 'start' ? startTime : endTime);
    if (!base) return;
    const next = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    if (which === 'start') {
      setStartDate(toDateInput(next));
      setStartTime(toTimeInput(next));
    } else {
      setEndDate(toDateInput(next));
      setEndTime(toTimeInput(next));
    }
  }

  async function toggleInterested(eventId: string) {
    const list = rsvps[eventId] || [];
    const mine = list.find(r => r.memberKey === myKey && r.status === RSVP_INTERESTED);
    try {
      if (mine) {
        const result = await clearEventRsvp(eventId);
        broadcastOp(orgId, result.opBytes);
      } else {
        const result = await setEventRsvp(eventId, RSVP_INTERESTED);
        broadcastOp(orgId, result.opBytes);
      }
      const updated = await listEventRsvps(eventId);
      setRsvps(s => ({ ...s, [eventId]: updated }));
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update RSVP');
    }
  }

  function openQrInvite() {
    try {
      const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const token = generateInviteToken(orgId, 'Read', expiry);
      setQrToken(token);
      setQrOpen(true);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to generate invite');
    }
  }

  function formatDateTime(micros: number) {
    const dt = new Date(micros / 1000);
    return dt.toLocaleString();
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Events</Text>
        <TouchableOpacity style={s.headerBtn} onPress={openCreate}>
          <Text style={s.headerBtnText}>Create</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.emptyWrap}>
          <Text style={s.emptyTitle}>Loading events…</Text>
        </View>
      ) : events.length === 0 ? (
        <View style={s.emptyWrap}>
          <View style={s.emptyIcon}>
            <Calendar size={28} color="#9aa1ad" />
          </View>
          <Text style={s.emptyTitle}>There are no upcoming events.</Text>
          <Text style={s.emptyBody}>Schedule an event for any planned activity in your server.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.list}>
          {events.map((ev) => {
            const list = rsvps[ev.eventId] || [];
            const interestedCount = list.filter(r => r.status === RSVP_INTERESTED).length;
            const mine = list.some(r => r.memberKey === myKey && r.status === RSVP_INTERESTED);
            const locationLabel = ev.locationType === 'room'
              ? `#${rooms.find(r => r.roomId === ev.locationRoomId)?.name ?? 'channel'}`
              : ev.locationText || 'Somewhere else';

            return (
              <View key={ev.eventId} style={s.card}>
                <Text style={s.cardTime}>{formatDateTime(ev.startAt)}</Text>
                <Text style={s.cardTitle}>{ev.title}</Text>
                <View style={s.cardRow}>
                  {ev.locationType === 'room' ? (
                    <Hash size={14} color="#8b93a1" />
                  ) : (
                    <MapPin size={14} color="#8b93a1" />
                  )}
                  <Text style={s.cardMeta}>{locationLabel}</Text>
                </View>
                <View style={s.cardActions}>
                  <TouchableOpacity
                    style={[s.interestedBtn, mine && s.interestedBtnActive]}
                    onPress={() => toggleInterested(ev.eventId)}
                  >
                    {mine && <Check size={14} color="#0b0b0b" />}
                    <Text style={[s.interestedText, mine && s.interestedTextActive]}>
                      {mine ? 'Interested' : 'Mark Interested'}
                    </Text>
                  </TouchableOpacity>
                  <View style={s.countPill}>
                    <Text style={s.countText}>{interestedCount}</Text>
                  </View>
                  <TouchableOpacity style={s.shareBtn} onPress={openQrInvite}>
                    <Share2 size={16} color="#c9ced8" />
                  </TouchableOpacity>
                  <TouchableOpacity style={s.iconBtn} onPress={() => openEdit(ev)}>
                    <Pencil size={16} color="#c9ced8" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.iconBtn}
                    onPress={() => {
                      Alert.alert('Delete Event', 'Are you sure you want to delete this event?', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: async () => {
                            try {
                              const result = await deleteEvent(orgId, ev.eventId);
                              broadcastOp(orgId, result.opBytes);
                              await refresh();
                            } catch (err: any) {
                              Alert.alert('Error', err?.message || 'Failed to delete event');
                            }
                          },
                        },
                      ]);
                    }}
                  >
                    <Trash2 size={16} color="#c9ced8" />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Create Event modal */}
      <Modal visible={createOpen} animationType="slide" transparent>
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <View style={s.modalHeader}>
              <Text style={s.modalStep}>STEP {createStep} OF 3</Text>
              <TouchableOpacity onPress={() => setCreateOpen(false)}>
                <X size={18} color="#a7acb8" />
              </TouchableOpacity>
            </View>

            {createStep === 1 && (
              <>
                <Text style={s.modalTitle}>Where is your event?</Text>
                <Text style={s.modalSubtitle}>So no one gets lost on where to go.</Text>
                <TouchableOpacity
                  style={[s.optionRow, locationType === 'room' && s.optionRowActive]}
                  onPress={() => setLocationType('room')}
                >
                  <Hash size={18} color="#c9ced8" />
                  <View style={s.optionTextWrap}>
                    <Text style={s.optionTitle}>Channel</Text>
                    <Text style={s.optionDesc}>Hang out with voice, video, or text.</Text>
                  </View>
                  <View style={[s.radio, locationType === 'room' && s.radioActive]} />
                </TouchableOpacity>

                {locationType === 'room' && (
                  <ScrollView style={s.roomPicker}>
                    {roomOptions.map(room => (
                      <TouchableOpacity
                        key={room.roomId}
                        style={[s.roomRow, locationRoomId === room.roomId && s.roomRowActive]}
                        onPress={() => setLocationRoomId(room.roomId)}
                      >
                        <Text style={s.roomText}># {room.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}

                <TouchableOpacity
                  style={[s.optionRow, locationType === 'somewhere_else' && s.optionRowActive]}
                  onPress={() => setLocationType('somewhere_else')}
                >
                  <MapPin size={18} color="#c9ced8" />
                  <View style={s.optionTextWrap}>
                    <Text style={s.optionTitle}>Somewhere Else</Text>
                    <Text style={s.optionDesc}>Text channel, external link, or in-person.</Text>
                  </View>
                  <View style={[s.radio, locationType === 'somewhere_else' && s.radioActive]} />
                </TouchableOpacity>

                {locationType === 'somewhere_else' && (
                  <TextInput
                    value={locationText}
                    onChangeText={setLocationText}
                    placeholder="Add a location, link, or something."
                    placeholderTextColor="#666"
                    style={s.input}
                  />
                )}

                <TouchableOpacity style={s.primaryBtn} onPress={() => setCreateStep(2)}>
                  <Text style={s.primaryBtnText}>Next</Text>
                </TouchableOpacity>
              </>
            )}

            {createStep === 2 && (
              <>
                <Text style={s.modalTitle}>What's your event about?</Text>
                <Text style={s.modalSubtitle}>Fill out the details of your event.</Text>

                <Text style={s.fieldLabel}>Event Topic</Text>
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="What's your event?"
                  placeholderTextColor="#666"
                  style={s.input}
                />

                <View style={s.inlineRow}>
                  <View style={s.inlineCol}>
                    <Text style={s.fieldLabel}>Start Date</Text>
                    <TextInput
                      value={startDate}
                      onChangeText={setStartDate}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor="#666"
                      style={s.input}
                    />
                  </View>
                  <View style={s.inlineCol}>
                    <Text style={s.fieldLabel}>Start Time</Text>
                    <TextInput
                      value={startTime}
                      onChangeText={setStartTime}
                      placeholder="HH:MM"
                      placeholderTextColor="#666"
                      style={s.input}
                    />
                  </View>
                </View>

                <View style={s.segmentRow}>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustDate('start', -1)}>
                    <Text style={s.segmentText}>Yesterday</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustDate('start', 0)}>
                    <Text style={s.segmentText}>Today</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustDate('start', 1)}>
                    <Text style={s.segmentText}>Tomorrow</Text>
                  </TouchableOpacity>
                </View>
                <View style={s.segmentRow}>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustTime('start', -30)}>
                    <Text style={s.segmentText}>-30m</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustTime('start', 30)}>
                    <Text style={s.segmentText}>+30m</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustTime('start', 60)}>
                    <Text style={s.segmentText}>+1h</Text>
                  </TouchableOpacity>
                </View>

                <View style={s.inlineRow}>
                  <View style={s.inlineCol}>
                    <Text style={s.fieldLabel}>End Date</Text>
                    <TextInput
                      value={endDate}
                      onChangeText={setEndDate}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor="#666"
                      style={s.input}
                    />
                  </View>
                  <View style={s.inlineCol}>
                    <Text style={s.fieldLabel}>End Time</Text>
                    <TextInput
                      value={endTime}
                      onChangeText={setEndTime}
                      placeholder="HH:MM"
                      placeholderTextColor="#666"
                      style={s.input}
                    />
                  </View>
                </View>

                <View style={s.segmentRow}>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustDate('end', -1)}>
                    <Text style={s.segmentText}>Yesterday</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustDate('end', 0)}>
                    <Text style={s.segmentText}>Today</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustDate('end', 1)}>
                    <Text style={s.segmentText}>Tomorrow</Text>
                  </TouchableOpacity>
                </View>
                <View style={s.segmentRow}>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustTime('end', -30)}>
                    <Text style={s.segmentText}>-30m</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustTime('end', 30)}>
                    <Text style={s.segmentText}>+30m</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.segmentBtn} onPress={() => adjustTime('end', 60)}>
                    <Text style={s.segmentText}>+1h</Text>
                  </TouchableOpacity>
                </View>

                <Text style={s.fieldLabel}>Description</Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Tell people a little more about your event."
                  placeholderTextColor="#666"
                  style={[s.input, s.inputMultiline]}
                  multiline
                  numberOfLines={3}
                />

                <TouchableOpacity style={s.primaryBtn} onPress={() => setCreateStep(3)}>
                  <Text style={s.primaryBtnText}>Next</Text>
                </TouchableOpacity>
              </>
            )}

            {createStep === 3 && (
              <>
                <Text style={s.modalTitle}>Here's a preview of your event.</Text>
                <Text style={s.modalSubtitle}>This event will auto start when it's time.</Text>

                <View style={s.previewCard}>
                  <Text style={s.previewTime}>{`${startDate} ${startTime}`}</Text>
                  <Text style={s.previewTitle}>{title || 'Untitled'}</Text>
                  <Text style={s.previewLocation}>
                    {locationType === 'room'
                      ? `#${rooms.find(r => r.roomId === locationRoomId)?.name ?? 'channel'}`
                      : locationText || 'Somewhere else'}
                  </Text>
                </View>

                <TouchableOpacity
                  style={[s.primaryBtn, creating && s.primaryBtnDisabled]}
                  onPress={handleCreateOrUpdate}
                  disabled={creating}
                >
                  <Text style={s.primaryBtnText}>
                    {creating ? 'Saving…' : (editEventId ? 'Save Changes' : 'Create Event')}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* QR Invite modal */}
      <Modal visible={qrOpen} animationType="fade" transparent>
        <View style={s.modalBackdrop}>
          <View style={s.qrCard}>
            <View style={s.qrHeader}>
              <Text style={s.qrTitle}>Invite by QR Code</Text>
              <TouchableOpacity onPress={() => setQrOpen(false)}>
                <X size={18} color="#a7acb8" />
              </TouchableOpacity>
            </View>
            {qrToken && (
              <>
                <View style={s.qrWrap}>
                  <QRCode value={qrToken} size={220} backgroundColor="#fff" />
                </View>
                <Text style={s.qrCaption}>Scan the QR Code to join {orgName}</Text>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  headerBtn: { backgroundColor: '#5865f2', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14 },
  headerBtnText: { color: '#fff', fontWeight: '700' },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#1b1f28', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { color: '#e6e9ef', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  emptyBody: { color: '#8b93a1', fontSize: 13, textAlign: 'center', marginTop: 8 },

  list: { padding: 16, gap: 12 },
  card: { backgroundColor: '#14161c', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#1f2430' },
  cardTime: { color: '#9aa1ad', fontSize: 12, marginBottom: 6 },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 },
  cardMeta: { color: '#8b93a1', fontSize: 13 },
  cardActions: { flexDirection: 'row', alignItems: 'center', marginTop: 14, gap: 10 },
  interestedBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#1f2430', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  interestedBtnActive: { backgroundColor: '#e6ebff' },
  interestedText: { color: '#c9ced8', fontSize: 12, fontWeight: '600' },
  interestedTextActive: { color: '#0b0b0b' },
  countPill: { backgroundColor: '#1f2430', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  countText: { color: '#c9ced8', fontSize: 12, fontWeight: '700' },
  shareBtn: { marginLeft: 'auto', width: 34, height: 34, borderRadius: 17, backgroundColor: '#1f2430', alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#1f2430', alignItems: 'center', justifyContent: 'center' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 16 },
  modalCard: { backgroundColor: '#121418', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#1f2430' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  modalStep: { color: '#8b93a1', fontSize: 12, fontWeight: '700' },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  modalSubtitle: { color: '#8b93a1', fontSize: 13, marginTop: 6, marginBottom: 12 },

  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, backgroundColor: '#171a22', borderWidth: 1, borderColor: '#1f2430', marginBottom: 12 },
  optionRowActive: { borderColor: '#5865f2' },
  optionTextWrap: { flex: 1 },
  optionTitle: { color: '#fff', fontWeight: '700', fontSize: 14 },
  optionDesc: { color: '#8b93a1', fontSize: 12, marginTop: 4 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#3b3f4a' },
  radioActive: { backgroundColor: '#5865f2', borderColor: '#5865f2' },
  roomPicker: { maxHeight: 160, marginBottom: 12 },
  roomRow: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, marginBottom: 6, backgroundColor: '#14161c' },
  roomRowActive: { backgroundColor: '#21263a' },
  roomText: { color: '#c9ced8', fontSize: 13 },

  fieldLabel: { color: '#c9ced8', fontSize: 12, fontWeight: '700', marginBottom: 6, marginTop: 6 },
  input: { backgroundColor: '#171a22', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: '#fff', borderWidth: 1, borderColor: '#1f2430', marginBottom: 10 },
  inputMultiline: { height: 80, textAlignVertical: 'top' },
  inlineRow: { flexDirection: 'row', gap: 10 },
  inlineCol: { flex: 1 },
  segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  segmentBtn: { flex: 1, backgroundColor: '#1f2430', borderRadius: 10, paddingVertical: 8, alignItems: 'center' },
  segmentText: { color: '#c9ced8', fontSize: 12, fontWeight: '600' },

  primaryBtn: { backgroundColor: '#5865f2', paddingVertical: 12, borderRadius: 14, alignItems: 'center', marginTop: 8 },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: '#fff', fontWeight: '700' },

  previewCard: { backgroundColor: '#14161c', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#1f2430', marginVertical: 16 },
  previewTime: { color: '#9aa1ad', fontSize: 12, marginBottom: 6 },
  previewTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  previewLocation: { color: '#8b93a1', fontSize: 13, marginTop: 8 },

  qrCard: { backgroundColor: '#121418', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#1f2430', alignItems: 'center' },
  qrHeader: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  qrTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  qrWrap: { backgroundColor: '#fff', padding: 16, borderRadius: 12, marginBottom: 12 },
  qrCaption: { color: '#8b93a1', fontSize: 12, textAlign: 'center' },
});

/**
 * FuelLogScreen — fuel fill-up tracking, spending summary, and MPG trend.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal,
  Platform, Pressable, RefreshControl, SafeAreaView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { apiClient } from '../services/apiClient';
import { SkeletonBox } from '../components/SkeletonLoader';

// --- Types ---

interface FuelEntry {
  id: string;
  date: string;
  gallons: number;
  pricePerGallon: number;
  notes?: string;
  location?: string;
  mpg?: number;
}

// --- Helpers ---

const fmt$ = (n: number) => `$${n.toFixed(2)}`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const todayMDY = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};
const parseMDY = (s: string): string | null => {
  const p = s.split('/').map(Number);
  return p.length === 3 && p[0] && p[1] && p[2] > 2000
    ? new Date(p[2], p[0] - 1, p[1]).toISOString()
    : null;
};

// --- MPG week bar chart ---

const MAX_BAR_H = 48;
const WEEK_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function MpgTrend({ entries }: { entries: FuelEntry[] }) {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() + (now.getDay() === 0 ? -6 : 1 - now.getDay()));
  mon.setHours(0, 0, 0, 0);

  const bars = WEEK_LABELS.map((_, i) => {
    const day = new Date(mon);
    day.setDate(mon.getDate() + i);
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const items = entries.filter(e => {
      const t = new Date(e.date).getTime();
      return t >= day.getTime() && t < next.getTime() && e.mpg != null;
    });
    return items.length ? items.reduce((s, e) => s + (e.mpg ?? 0), 0) / items.length : null;
  });

  const max = Math.max(...bars.filter((b): b is number => b !== null), 1);

  return (
    <View style={s.mpgCard}>
      <Text style={s.sectionLabel}>MPG This Week</Text>
      <View style={s.mpgBars}>
        {bars.map((v, i) => (
          <View key={i} style={s.mpgBarCol}>
            <View style={s.mpgBarTrack}>
              <View style={[s.mpgBar, { height: v ? Math.max(4, (v / max) * MAX_BAR_H) : 4, backgroundColor: v ? '#888888' : '#2A2A2A' }]} />
            </View>
            <Text style={s.mpgBarLabel}>{WEEK_LABELS[i]}</Text>
            {v ? <Text style={s.mpgBarVal}>{v.toFixed(0)}</Text> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

// --- Entry row — long-press reveals delete / cancel ---

function EntryRow({ entry, onDelete }: { entry: FuelEntry; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const total = entry.gallons * entry.pricePerGallon;

  return (
    <Pressable
      onLongPress={() => setOpen(prev => !prev)}
      style={[s.entryCard, open && s.entryCardOpen]}
      accessibilityRole="button"
      accessibilityLabel={`Fuel log ${fmtDate(entry.date)}`}
    >
      <View style={s.entryRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.entryDate}>{fmtDate(entry.date)}</Text>
          {entry.location ? <Text style={s.entryMeta} numberOfLines={1}>{entry.location}</Text> : null}
          {entry.notes ? <Text style={s.entryNotes} numberOfLines={1}>{entry.notes}</Text> : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.entryTotal}>{fmt$(total)}</Text>
          <Text style={s.entryMeta}>{entry.gallons} gal · {fmt$(entry.pricePerGallon)}/gal</Text>
          {entry.mpg ? <Text style={s.entryMpg}>{entry.mpg.toFixed(1)} mpg</Text> : null}
        </View>
      </View>
      {open && (
        <View style={s.entryActions}>
          <TouchableOpacity
            style={s.delBtn}
            onPress={() => { setOpen(false); onDelete(entry.id); }}
            accessibilityRole="button"
            accessibilityLabel="Delete entry"
          >
            <Text style={s.delText}>🗑 Delete</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.cancelBtn} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
    </Pressable>
  );
}

// --- Add fuel modal ---

function AddModal({ visible, onClose, onSaved }: {
  visible: boolean; onClose: () => void; onSaved: (e: FuelEntry) => void;
}) {
  const [gallons, setGallons] = useState('');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState(todayMDY());
  const [saving, setSaving] = useState(false);

  const close = () => { setGallons(''); setPrice(''); setNotes(''); setDate(todayMDY()); onClose(); };

  const save = async () => {
    const gal = parseFloat(gallons), ppg = parseFloat(price);
    if (!gal || gal <= 0) { Alert.alert('Validation', 'Enter a valid gallon amount.'); return; }
    if (!ppg || ppg <= 0) { Alert.alert('Validation', 'Enter a valid price per gallon.'); return; }
    const iso = parseMDY(date);
    if (!iso) { Alert.alert('Validation', 'Use MM/DD/YYYY for the date.'); return; }
    setSaving(true);
    try {
      const res = await apiClient.post<FuelEntry>('/api/v1/fuel/logs', {
        gallons: gal, pricePerGallon: ppg, notes: notes.trim() || undefined, date: iso,
      });
      onSaved(res.data);
      close();
    } catch {
      Alert.alert('Error', 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.sheet}>
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Add Fill-Up</Text>
            <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={s.sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Gallons</Text>
              <TextInput style={s.input} value={gallons} onChangeText={setGallons} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor="#555" accessibilityLabel="Gallons" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Price / Gallon</Text>
              <TextInput style={s.input} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor="#555" accessibilityLabel="Price per gallon" />
            </View>
          </View>

          <Text style={s.label}>Date (MM/DD/YYYY)</Text>
          <TextInput style={[s.input, { marginBottom: 12 }]} value={date} onChangeText={setDate} placeholder="MM/DD/YYYY" placeholderTextColor="#555" accessibilityLabel="Date" />

          <Text style={s.label}>Notes (optional)</Text>
          <TextInput style={[s.input, { height: 64, textAlignVertical: 'top', marginBottom: 16 }]} value={notes} onChangeText={setNotes} placeholder="Station, brand…" placeholderTextColor="#555" multiline accessibilityLabel="Notes" />

          <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={() => { void save(); }} disabled={saving} accessibilityRole="button" accessibilityLabel="Save fill-up">
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.saveBtnText}>Save Fill-Up</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// --- Main screen ---

export default function FuelLogScreen() {
  const [entries, setEntries] = useState<FuelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ logs: FuelEntry[] }>('/api/v1/fuel/logs');
      setEntries(r.data.logs);
    } catch {
      Alert.alert('Error', 'Could not load fuel logs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const onDelete = useCallback((id: string) => {
    Alert.alert('Delete Entry', 'Remove this fuel log?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.delete(`/api/v1/fuel/logs/${id}`);
            setEntries(prev => prev.filter(e => e.id !== id));
          } catch {
            Alert.alert('Error', 'Could not delete entry.');
          }
        },
      },
    ]);
  }, []);

  const totalGal = entries.reduce((s, e) => s + e.gallons, 0);
  const totalSpent = entries.reduce((s, e) => s + e.gallons * e.pricePerGallon, 0);
  const avgPpg = totalGal > 0 ? entries.reduce((s, e) => s + e.pricePerGallon * e.gallons, 0) / totalGal : 0;
  const stats = [
    { icon: '⛽', label: 'Total Spent', val: entries.length ? fmt$(totalSpent) : '—' },
    { icon: '💰', label: 'Avg $/Gallon', val: avgPpg > 0 ? fmt$(avgPpg) : '—' },
    { icon: '🧮', label: 'Total Gallons', val: totalGal > 0 ? totalGal.toFixed(1) : '—' },
  ];

  if (loading) {
    return (
      <SafeAreaView style={s.bg}>
        <View style={s.header}><Text style={s.title}>Fuel Log</Text></View>
        <View style={{ padding: 16, gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
            {[0, 1, 2].map((i) => <SkeletonBox key={i} width="30%" height={72} borderRadius={12} />)}
          </View>
          {[0, 1, 2, 3].map((i) => <SkeletonBox key={i} width="100%" height={64} borderRadius={12} />)}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.bg}>
      <View style={s.header}><Text style={s.title}>Fuel Log</Text></View>
      <FlatList
        data={entries}
        keyExtractor={e => e.id}
        contentContainerStyle={entries.length === 0 ? s.listEmpty : s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }} tintColor="#DC143C" colors={['#DC143C']} />}
        ListHeaderComponent={entries.length > 0 ? (
          <>
            <View style={s.summaryRow}>
              {stats.map((c, i) => (
                <View key={i} style={s.statCard}>
                  <Text style={{ fontSize: 20, marginBottom: 4 }}>{c.icon}</Text>
                  <Text style={s.statVal}>{c.val}</Text>
                  <Text style={s.statLabel}>{c.label}</Text>
                </View>
              ))}
            </View>
            <MpgTrend entries={entries} />
            <Text style={[s.sectionLabel, { marginBottom: 4 }]}>Fill-Up History</Text>
            <Text style={s.hint}>Long-press an entry to delete</Text>
          </>
        ) : null}
        renderItem={({ item }) => <EntryRow entry={item} onDelete={onDelete} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={{ fontSize: 56, marginBottom: 16 }}>⛽</Text>
            <Text style={s.emptyTitle}>No fuel logs yet</Text>
            <Text style={s.emptySub}>Tap + to add your first fill-up and start tracking spending.</Text>
          </View>
        }
      />

      {/* FAB — bottom-right, 56 px crimson */}
      <TouchableOpacity style={s.fab} onPress={() => setShowModal(true)} accessibilityRole="button" accessibilityLabel="Add fuel log">
        <Text style={s.fabText}>+</Text>
      </TouchableOpacity>

      <AddModal visible={showModal} onClose={() => setShowModal(false)} onSaved={e => setEntries(prev => [e, ...prev])} />
    </SafeAreaView>
  );
}

// --- Styles ---

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: '#0A0A0A' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  title: { color: '#FFFFFF', fontSize: 24, fontWeight: '700' },
  list: { paddingHorizontal: 16, paddingBottom: 100 },
  listEmpty: { flex: 1, paddingHorizontal: 16 },

  summaryRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: '#1C1C1C', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#2A2A2A' },
  statVal: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', marginBottom: 2 },
  statLabel: { color: '#888888', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'center' },

  mpgCard: { backgroundColor: '#1C1C1C', borderRadius: 12, borderWidth: 1, borderColor: '#2A2A2A', padding: 14, marginBottom: 16 },
  mpgBars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 4 },
  mpgBarCol: { flex: 1, alignItems: 'center', gap: 4 },
  mpgBarTrack: { height: MAX_BAR_H, justifyContent: 'flex-end' },
  mpgBar: { width: '100%', borderRadius: 3, minHeight: 4 },
  mpgBarLabel: { color: '#555555', fontSize: 10 },
  mpgBarVal: { color: '#888888', fontSize: 9 },

  sectionLabel: { color: '#888888', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  hint: { color: '#555555', fontSize: 11, marginBottom: 10, fontStyle: 'italic' },

  entryCard: { backgroundColor: '#1C1C1C', borderRadius: 12, borderWidth: 1, borderColor: '#2A2A2A', marginBottom: 10, overflow: 'hidden' },
  entryCardOpen: { borderColor: '#DC143C' },
  entryRow: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  entryDate: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', marginBottom: 2 },
  entryMeta: { color: '#888888', fontSize: 12 },
  entryNotes: { color: '#555555', fontSize: 11, fontStyle: 'italic' },
  entryTotal: { color: '#DC143C', fontSize: 16, fontWeight: '700' },
  entryMpg: { color: '#22C55E', fontSize: 11, marginTop: 2 },
  entryActions: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#2A2A2A', backgroundColor: '#242424' },
  delBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRightWidth: 1, borderRightColor: '#2A2A2A' },
  delText: { color: '#DC143C', fontSize: 13, fontWeight: '600' },
  cancelBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: '#888888', fontSize: 13 },

  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: '#1C1C1C', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, borderTopWidth: 1, borderTopColor: '#2A2A2A' },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  sheetTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  sheetClose: { color: '#888888', fontSize: 20, padding: 4 },
  label: { color: '#888888', fontSize: 12, marginBottom: 6, fontWeight: '500' },
  input: { backgroundColor: '#242424', borderRadius: 10, borderWidth: 1, borderColor: '#2A2A2A', color: '#FFFFFF', paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 12 },
  saveBtn: { backgroundColor: '#DC143C', borderRadius: 12, paddingVertical: 15, alignItems: 'center', minHeight: 50 },
  saveBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  fab: { position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#DC143C', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8 },
  fabText: { color: '#FFFFFF', fontSize: 28, fontWeight: '300', lineHeight: 32 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySub: { color: '#888888', fontSize: 14, textAlign: 'center', lineHeight: 22 },
});

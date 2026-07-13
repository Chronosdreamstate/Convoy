/**
 * FuelLogScreen — fuel fill-up tracking, spending summary, and MPG trend.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal,
  Platform, Pressable, RefreshControl, SafeAreaView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { SkeletonBox } from '../components/SkeletonLoader';
import { useSettingsStore } from '../stores/settingsStore';
import { useTheme, withAlpha, ThemeColors } from '../theme';

// Fixed white for text/icons sitting on the accent fill — the accent color is
// the same in both themes, while colors.text flips to near-black in light mode
// and would be unreadable on this fill (ON_ACCENT convention).
const ON_ACCENT = '#FFFFFF';

// --- Types ---

interface FuelEntry {
  id: string;
  date: string;
  gallons: number;
  pricePerGallon: number;
  notes?: string;
  location?: string;
  mpg?: number;
  odometerKm?: number;
}

// --- Helpers ---

const KM_PER_MILE = 1.609344;

const fmt$ = (n: number) => `$${n.toFixed(2)}`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const todayMDY = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};
const parseMDY = (s: string): string | null => {
  const p = s.split('/').map(Number);
  if (p.length !== 3 || !p[0] || !p[1] || !p[2] || p[2] <= 2000) return null;
  const [month, day, year] = p;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // Date() silently rolls invalid combinations (e.g. Feb 30) into the next
  // month — reject anything that didn't land on the month the user typed.
  if (d.getMonth() !== month - 1) return null;
  return d.toISOString();
};

// --- MPG week bar chart ---

const MAX_BAR_H = 48;
const WEEK_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function MpgTrend({ entries }: { entries: FuelEntry[] }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
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
              <View style={[s.mpgBar, { height: v ? Math.max(4, (v / max) * MAX_BAR_H) : 4, backgroundColor: v ? colors.textMuted : colors.border }]} />
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

function EntryRow({ entry, onDelete, deleting }: { entry: FuelEntry; onDelete: (id: string) => void; deleting: boolean }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const total = entry.gallons * entry.pricePerGallon;

  return (
    <Pressable
      onLongPress={() => !deleting && setOpen(prev => !prev)}
      style={[s.entryCard, open && s.entryCardOpen, deleting && s.entryCardDeleting]}
      disabled={deleting}
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
      {open && !deleting && (
        <View style={s.entryActions}>
          <TouchableOpacity
            style={s.delBtn}
            onPress={() => { setOpen(false); onDelete(entry.id); }}
            accessibilityRole="button"
            accessibilityLabel="Delete entry"
          >
            <Ionicons name="trash-outline" size={14} color={colors.accent} />
            <Text style={s.delText}> Delete</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.cancelBtn} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
      {deleting && (
        <View style={s.deletingOverlay}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      )}
    </Pressable>
  );
}

// --- Add fuel modal ---

function AddModal({ visible, onClose, onSaved }: {
  visible: boolean; onClose: () => void; onSaved: (e: FuelEntry) => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const distanceUnit = useSettingsStore((s) => s.distanceUnit);
  const odometerLabel = distanceUnit === 'miles' ? 'Odometer (mi)' : 'Odometer (km)';

  const [gallons, setGallons] = useState('');
  const [price, setPrice] = useState('');
  const [odometer, setOdometer] = useState('');
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState(todayMDY());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setGallons(''); setPrice(''); setOdometer(''); setNotes(''); setDate(todayMDY()); setError(null); onClose();
  };

  const save = async () => {
    setError(null);
    const gal = parseFloat(gallons), ppg = parseFloat(price);
    if (!gal || gal <= 0) { setError('Enter a valid gallon amount.'); return; }
    if (!ppg || ppg <= 0) { setError('Enter a valid price per gallon.'); return; }
    const iso = parseMDY(date);
    if (!iso) { setError('Use MM/DD/YYYY for the date.'); return; }

    let odometerKm: number | undefined;
    if (odometer.trim()) {
      const odo = parseFloat(odometer);
      if (!odo || odo <= 0) { setError('Enter a valid odometer reading.'); return; }
      // Always send odometer to the API in km — the server stores/compares
      // in km regardless of the user's display unit preference.
      odometerKm = distanceUnit === 'miles' ? odo * KM_PER_MILE : odo;
    }

    setSaving(true);
    try {
      const res = await apiClient.post<FuelEntry>('/api/v1/fuel/logs', {
        gallons: gal, pricePerGallon: ppg, notes: notes.trim() || undefined, date: iso, odometerKm,
      });
      onSaved(res.data);
      close();
    } catch {
      setError('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.sheet}>
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Add Fill-Up</Text>
            <TouchableOpacity
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close" size={22} color={colors.textMuted} style={{ padding: 4 }} />
            </TouchableOpacity>
          </View>

          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Gallons</Text>
              <TextInput style={s.input} value={gallons} onChangeText={setGallons} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.textSubtle} accessibilityLabel="Gallons" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Price / Gallon</Text>
              <TextInput style={s.input} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.textSubtle} accessibilityLabel="Price per gallon" />
            </View>
          </View>

          <Text style={s.label}>Date (MM/DD/YYYY)</Text>
          <TextInput style={[s.input, { marginBottom: 12 }]} value={date} onChangeText={setDate} placeholder="MM/DD/YYYY" placeholderTextColor={colors.textSubtle} accessibilityLabel="Date" />

          <Text style={s.label}>{odometerLabel} (optional)</Text>
          <TextInput
            style={[s.input, { marginBottom: 12 }]}
            value={odometer}
            onChangeText={setOdometer}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={colors.textSubtle}
            accessibilityLabel={odometerLabel}
          />

          <Text style={s.label}>Notes (optional)</Text>
          <TextInput style={[s.input, { height: 64, textAlignVertical: 'top', marginBottom: 16 }]} value={notes} onChangeText={setNotes} placeholder="Station, brand…" placeholderTextColor={colors.textSubtle} multiline accessibilityLabel="Notes" />

          {error ? <Text style={s.formErrorTxt}>{error}</Text> : null}

          <TouchableOpacity
            style={[s.saveBtn, saving && { opacity: 0.6 }]}
            onPress={() => { void save(); }}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Save fill-up"
            accessibilityState={{ disabled: saving }}
          >
            {saving ? <ActivityIndicator color={ON_ACCENT} /> : <Text style={s.saveBtnText}>Save Fill-Up</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// --- Main screen ---

export default function FuelLogScreen() {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [entries, setEntries] = useState<FuelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await apiClient.get<{ logs: FuelEntry[] }>('/api/v1/fuel/logs');
      setEntries(r.data.logs);
    } catch {
      // Distinct from the "no logs yet" empty state — a failed load must
      // never be mistaken for a genuinely empty fuel log.
      setLoadError('Could not load fuel logs.');
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
          setDeletingId(id);
          try {
            await apiClient.delete(`/api/v1/fuel/logs/${id}`);
            setEntries(prev => prev.filter(e => e.id !== id));
          } catch {
            Alert.alert('Error', 'Could not delete entry.');
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  }, []);

  const renderEntryItem = useCallback(
    ({ item }: { item: FuelEntry }) => <EntryRow entry={item} onDelete={onDelete} deleting={deletingId === item.id} />,
    [onDelete, deletingId],
  );

  // Req 33 — cap the fill-up history to 4 rows while the vehicle is in motion
  // (see MotionAwareList). Summary stats above still use every entry.
  const { data: visibleEntries, hiddenCount } = useMotionCappedData(entries);

  const totalGal = entries.reduce((s, e) => s + e.gallons, 0);
  const totalSpent = entries.reduce((s, e) => s + e.gallons * e.pricePerGallon, 0);
  const avgPpg = totalGal > 0 ? entries.reduce((s, e) => s + e.pricePerGallon * e.gallons, 0) / totalGal : 0;
  const stats: Array<{ icon: React.ReactNode; label: string; val: string }> = [
    { icon: <MaterialCommunityIcons name="gas-station" size={20} color={colors.text} />, label: 'Total Spent', val: entries.length ? fmt$(totalSpent) : '—' },
    { icon: <Ionicons name="cash-outline" size={20} color={colors.text} />, label: 'Avg $/Gallon', val: avgPpg > 0 ? fmt$(avgPpg) : '—' },
    { icon: <MaterialCommunityIcons name="water-outline" size={20} color={colors.text} />, label: 'Total Gallons', val: totalGal > 0 ? totalGal.toFixed(1) : '—' },
  ];

  if (loading) {
    return (
      <SafeAreaView style={s.bg}>
        <View style={s.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={s.back}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={s.title}>Fuel Log</Text>
        </View>
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
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={s.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Fuel Log</Text>
      </View>
      <FlatList
        data={visibleEntries}
        keyExtractor={e => e.id}
        contentContainerStyle={entries.length === 0 ? s.listEmpty : s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }} tintColor={colors.accent} colors={[colors.accent]} />}
        ListHeaderComponent={entries.length > 0 ? (
          <>
            <View style={s.summaryRow}>
              {stats.map((c, i) => (
                <View key={i} style={[s.statCard, i === 0 && s.statCardPrimary]}>
                  <View style={{ marginBottom: 4 }}>{c.icon}</View>
                  <Text style={[s.statVal, i === 0 && s.statValPrimary]}>{c.val}</Text>
                  <Text style={s.statLabel}>{c.label}</Text>
                </View>
              ))}
            </View>
            <MpgTrend entries={entries} />
            <Text style={[s.sectionLabel, { marginBottom: 4 }]}>Fill-Up History</Text>
            <Text style={s.hint}>Long-press an entry to delete</Text>
          </>
        ) : null}
        renderItem={renderEntryItem}
        ListFooterComponent={<MotionCapNotice hiddenCount={hiddenCount} />}
        ListEmptyComponent={
          loadError ? (
            <View style={s.empty}>
              <MaterialCommunityIcons name="alert-circle-outline" size={56} color={colors.textMuted} style={{ marginBottom: 16 }} />
              <Text style={s.emptyTitle}>Couldn't load fuel logs</Text>
              <Text style={s.emptySub}>{loadError}</Text>
              <TouchableOpacity
                style={s.emptyButton}
                onPress={() => { void load(); }}
                accessibilityRole="button"
                accessibilityLabel="Retry loading fuel logs"
              >
                <Text style={s.emptyButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.empty}>
              <MaterialCommunityIcons name="gas-station" size={56} color={colors.textMuted} style={{ marginBottom: 16 }} />
              <Text style={s.emptyTitle}>No fuel logs yet</Text>
              <Text style={s.emptySub}>Tap + to add your first fill-up and start tracking spending.</Text>
            </View>
          )
        }
      />

      {/* FAB — bottom-right, 56 px crimson */}
      <TouchableOpacity style={s.fab} onPress={() => setShowModal(true)} accessibilityRole="button" accessibilityLabel="Add fuel log">
        <Ionicons name="add" size={30} color={ON_ACCENT} />
      </TouchableOpacity>

      <AddModal visible={showModal} onClose={() => setShowModal(false)} onSaved={e => setEntries(prev => [e, ...prev])} />
    </SafeAreaView>
  );
}

// --- Styles ---

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    bg: { flex: 1, backgroundColor: colors.bg },
    header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 4 },
    back: { color: colors.accent, fontSize: 16, fontWeight: '600' },
    title: { color: colors.text, fontSize: 24, fontWeight: '700' },
    list: { paddingHorizontal: 16, paddingBottom: 100 },
    listEmpty: { flex: 1, paddingHorizontal: 16 },

    summaryRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
    statCard: { flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
    // Total Spent is the stat drivers care about most at a glance — give it
    // more visual weight than Avg $/Gallon and Total Gallons instead of
    // letting all three compete equally.
    statCardPrimary: { borderColor: withAlpha(colors.accent, 0.35), backgroundColor: colors.cardElevated },
    statVal: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 2 },
    statValPrimary: { color: colors.accent, fontSize: 19 },
    statLabel: { color: colors.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'center' },

    mpgCard: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 16 },
    mpgBars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 4 },
    mpgBarCol: { flex: 1, alignItems: 'center', gap: 4 },
    mpgBarTrack: { height: MAX_BAR_H, justifyContent: 'flex-end' },
    mpgBar: { width: '100%', borderRadius: 3, minHeight: 4 },
    mpgBarLabel: { color: colors.textSubtle, fontSize: 10 },
    mpgBarVal: { color: colors.textMuted, fontSize: 9 },

    sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
    hint: { color: colors.textSubtle, fontSize: 11, marginBottom: 10, fontStyle: 'italic' },

    entryCard: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginBottom: 10, overflow: 'hidden', position: 'relative' },
    entryCardOpen: { borderColor: colors.accent },
    entryCardDeleting: { opacity: 0.5 },
    deletingOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.bg, 0.5) },
    entryRow: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
    entryDate: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 2 },
    entryMeta: { color: colors.textMuted, fontSize: 12 },
    entryNotes: { color: colors.textSubtle, fontSize: 11, fontStyle: 'italic' },
    entryTotal: { color: colors.accent, fontSize: 16, fontWeight: '700' },
    entryMpg: { color: colors.success, fontSize: 11, marginTop: 2 },
    entryActions: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.cardElevated },
    delBtn: { flex: 1, flexDirection: 'row', paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRightWidth: 1, borderRightColor: colors.border },
    delText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    cancelBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
    cancelText: { color: colors.textMuted, fontSize: 13 },

    overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
    sheet: { backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, borderTopWidth: 1, borderTopColor: colors.border },
    sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
    label: { color: colors.textMuted, fontSize: 12, marginBottom: 6, fontWeight: '500' },
    input: { backgroundColor: colors.cardElevated, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 12 },
    formErrorTxt: { color: colors.accent, fontSize: 13, marginBottom: 12 },
    saveBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center', minHeight: 50 },
    saveBtnText: { color: ON_ACCENT, fontSize: 16, fontWeight: '700' },

    fab: { position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: colors.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8 },

    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 32 },
    emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
    emptySub: { color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
    emptyButton: {
      backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 40,
      alignItems: 'center', minHeight: 52, justifyContent: 'center',
      shadowColor: colors.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 6,
    },
    emptyButtonText: { color: ON_ACCENT, fontSize: 16, fontWeight: '700' },
  });
}

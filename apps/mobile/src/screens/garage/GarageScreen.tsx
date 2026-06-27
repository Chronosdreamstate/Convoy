import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView,
  ScrollView, ActivityIndicator, TextInput, Modal, Alert, RefreshControl, Switch,
} from 'react-native';
import { apiClient } from '../../services/apiClient';
import SkeletonCard from '../../components/SkeletonLoader';

// ---------- type helpers ----------
const TYPE_EMOJI: Record<string, string> = {
  Car: '🚗', Truck: '🚚', Motorcycle: '🏍️', SUV: '🚙', Classic: '🏎️', Sports: '🏎️',
};
const VEHICLE_TYPES = ['Car', 'Truck', 'Motorcycle', 'SUV', 'Classic', 'Sports'] as const;

const COLOR_SWATCHES = [
  { name: 'Red', hex: '#C0392B' },
  { name: 'Blue', hex: '#2980B9' },
  { name: 'Black', hex: '#1A1A1A' },
  { name: 'White', hex: '#F0F0F0' },
  { name: 'Silver', hex: '#A8A9AD' },
  { name: 'Gray', hex: '#7F8C8D' },
  { name: 'Yellow', hex: '#F1C40F' },
  { name: 'Green', hex: '#27AE60' },
  { name: 'Orange', hex: '#E67E22' },
  { name: 'Purple', hex: '#8E44AD' },
  { name: 'Gold', hex: '#D4AC0D' },
  { name: 'Brown', hex: '#795548' },
];

function vehicleEmoji(v: Vehicle): string {
  if (v.type && TYPE_EMOJI[v.type]) return TYPE_EMOJI[v.type];
  const mk = (v.make ?? '').toLowerCase();
  const ml = (v.model ?? '').toLowerCase();
  if (['ferrari','lambo','porsche','mclaren','corvette','mustang','supra','nsx','gtr'].some((k) => mk.includes(k) || ml.includes(k))) return '🏎️';
  if (['truck','pickup','f-150','silverado','tundra','tacoma','ranger'].some((k) => ml.includes(k)) || mk === 'ram') return '🚚';
  return '🚗';
}

function colorHex(colorName: string | null): string | null {
  if (!colorName) return null;
  const found = COLOR_SWATCHES.find((c) => c.name.toLowerCase() === colorName.toLowerCase());
  return found ? found.hex : null;
}

// ---------- types ----------
interface Vehicle {
  id: string;
  name?: string | null;
  type?: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  photoUrl: string | null;
  isActive: boolean;
  primary?: boolean;
  drivesCount?: number;
  createdAt: string;
}
interface VehicleForm {
  name: string;
  type: string;
  make: string;
  model: string;
  year: string;
  color: string;
  setAsPrimary: boolean;
}
const EMPTY_FORM: VehicleForm = { name: '', type: 'Car', make: '', model: '', year: '', color: '', setAsPrimary: false };

function vehicleDisplayName(v: Vehicle): string {
  if (v.name) return v.name;
  const parts = [v.make, v.model].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Unnamed vehicle';
}
function vehicleSubtitle(v: Vehicle): string {
  return [v.year ? String(v.year) : null, v.type ?? null].filter(Boolean).join(' · ');
}

// ---------- component ----------
export default function GarageScreen() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [mods, setMods] = useState<string[]>([]);
  const [newMod, setNewMod] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActivating, setIsActivating] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<VehicleForm>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => { void loadVehicles(); }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadVehicles(true);
    setIsRefreshing(false);
  }, []);

  const loadVehicles = async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<{ vehicles: Vehicle[]; mods?: string[] }>('/api/v1/vehicles');
      setVehicles(res.data.vehicles);
      if (res.data.mods) setMods(res.data.mods);
    } catch { setError('Failed to load garage. Please try again.'); }
    finally { if (!silent) setIsLoading(false); }
  };

  const openAddModal = () => {
    setEditingId(null); setForm(EMPTY_FORM); setFormError(null); setModalVisible(true);
  };
  const openEditModal = (v: Vehicle) => {
    setEditingId(v.id);
    setForm({
      name: v.name ?? vehicleDisplayName(v),
      type: v.type ?? 'Car',
      make: v.make ?? '',
      model: v.model ?? '',
      year: v.year != null ? String(v.year) : '',
      color: v.color ?? '',
      setAsPrimary: isPrimary(v),
    });
    setFormError(null);
    setModalVisible(true);
  };
  const closeModal = () => {
    setModalVisible(false); setEditingId(null); setForm(EMPTY_FORM); setFormError(null);
  };

  const handleSave = async () => {
    setFormError(null);
    const displayName = form.name.trim() || [form.make.trim(), form.model.trim()].filter(Boolean).join(' ');
    if (!displayName) { setFormError('Enter a vehicle name or make/model.'); return; }
    const yearNum = form.year.trim() ? parseInt(form.year, 10) : null;
    if (form.year.trim() && (isNaN(yearNum!) || yearNum! < 1885 || yearNum! > new Date().getFullYear() + 1)) {
      setFormError(`Enter a valid year between 1885 and ${new Date().getFullYear() + 1}.`); return;
    }
    const payload = {
      name: displayName,
      type: form.type,
      make: form.make.trim() || undefined,
      model: form.model.trim() || undefined,
      color: form.color || undefined,
      ...(yearNum != null ? { year: yearNum } : {}),
      ...(form.setAsPrimary ? { primary: true } : {}),
    };
    setIsSaving(true);
    try {
      if (editingId) {
        const res = await apiClient.patch<Vehicle>(`/api/v1/vehicles/${editingId}`, payload);
        setVehicles((prev) => prev.map((v) => {
          if (form.setAsPrimary) return { ...v, isActive: v.id === editingId, primary: v.id === editingId };
          return v.id === editingId ? res.data : v;
        }));
      } else {
        const res = await apiClient.post<Vehicle>('/api/v1/vehicles', payload);
        setVehicles((prev) => {
          const updated = [...prev, res.data];
          if (form.setAsPrimary) return updated.map((v) => ({ ...v, isActive: v.id === res.data.id, primary: v.id === res.data.id }));
          return updated;
        });
      }
      closeModal();
    } catch { setFormError('Failed to save vehicle. Please try again.'); }
    finally { setIsSaving(false); }
  };

  const handleDelete = (v: Vehicle) => {
    Alert.alert('Delete Vehicle', `Remove "${vehicleDisplayName(v)}" from your Garage?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await apiClient.delete(`/api/v1/vehicles/${v.id}`);
          setVehicles((prev) => prev.filter((veh) => veh.id !== v.id));
        } catch { Alert.alert('Error', 'Failed to delete vehicle.'); }
      }},
    ]);
  };

  const handleSetPrimary = async (v: Vehicle) => {
    if (v.isActive || v.primary || isActivating) return;
    setIsActivating(v.id);
    try {
      const Haptics = await import('expo-haptics').catch(() => null);
      if (Haptics) void Haptics.impactAsync('medium' as never);
    } catch { /* non-fatal */ }
    try {
      const res = await apiClient.post<Vehicle>(`/api/v1/vehicles/${v.id}/activate`);
      setVehicles((prev) => prev.map((veh) => ({
        ...veh, isActive: veh.id === res.data.id, primary: veh.id === res.data.id,
      })));
    } catch { Alert.alert('Error', 'Failed to set primary vehicle.'); }
    finally { setIsActivating(null); }
  };

  const isPrimary = (v: Vehicle) => v.isActive || !!v.primary;

  const openActionSheet = (v: Vehicle) => {
    Alert.alert(vehicleDisplayName(v), undefined, [
      { text: '⭐  Set as Main Ride', onPress: () => void handleSetPrimary(v) },
      { text: '✏️  Edit', onPress: () => openEditModal(v) },
      { text: '🗑️  Delete', style: 'destructive', onPress: () => handleDelete(v) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleAddMod = async () => {
    const mod = newMod.trim();
    if (!mod || mods.length >= 10) return;
    const updated = [...mods, mod];
    setMods(updated);
    setNewMod('');
    try { await apiClient.patch('/api/v1/users/me', { mods: updated }); } catch { /* non-fatal */ }
  };

  const handleRemoveMod = async (index: number) => {
    const updated = mods.filter((_, i) => i !== index);
    setMods(updated);
    try { await apiClient.patch('/api/v1/users/me', { mods: updated }); } catch { /* non-fatal */ }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.skeletonPad}>{[0, 1].map((i) => <SkeletonCard key={i} />)}</View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor="#DC143C" colors={['#DC143C']} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>Garage</Text>
          <Text style={styles.subtitle}>{vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''}</Text>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {vehicles.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🚗</Text>
            <Text style={styles.emptyTitle}>Add your first ride</Text>
            <Text style={styles.emptySubtitle}>
              Show the convoy what you're rolling in. Add your vehicles so crew members know who's driving what.
            </Text>
            <TouchableOpacity style={styles.emptyButton} onPress={openAddModal} accessibilityRole="button" accessibilityLabel="Add vehicle">
              <Text style={styles.emptyButtonText}>Add Vehicle</Text>
            </TouchableOpacity>
          </View>
        ) : (
          vehicles.map((v) => {
            const primary = isPrimary(v);
            const subtitle = vehicleSubtitle(v);
            const colorH = colorHex(v.color);
            return (
              <TouchableOpacity
                key={v.id}
                style={[styles.vehicleCard, primary && styles.vehicleCardPrimary]}
                onPress={() => void handleSetPrimary(v)}
                onLongPress={() => openActionSheet(v)}
                activeOpacity={primary ? 1 : 0.7}
                accessibilityRole="button"
                accessibilityLabel={`${vehicleDisplayName(v)}${primary ? ', main ride' : ', tap to set as main ride'}`}
              >
                {primary && <View style={styles.activeStrip} />}

                {primary && (
                  <View style={styles.primaryBadge}>
                    <Text style={styles.primaryBadgeText}>MAIN RIDE</Text>
                  </View>
                )}

                <View style={styles.vehicleIconBox}>
                  <Text style={styles.vehicleIcon}>{vehicleEmoji(v)}</Text>
                </View>

                <View style={styles.vehicleInfo}>
                  <View style={styles.nameRow}>
                    <Text style={styles.vehicleName} numberOfLines={1}>{vehicleDisplayName(v)}</Text>
                    {colorH ? (
                      <View style={[styles.colorSwatch, { backgroundColor: colorH, borderColor: colorH === '#F0F0F0' ? '#555' : colorH }]} />
                    ) : null}
                  </View>
                  {subtitle ? <Text style={styles.vehicleSubtitle}>{subtitle}</Text> : null}
                  <View style={styles.metaRow}>
                    {!primary && (isActivating === v.id
                      ? <ActivityIndicator color="#DC143C" size="small" />
                      : <Text style={styles.tapToActivate}>Tap to set as main ride</Text>
                    )}
                    {v.drivesCount != null && v.drivesCount > 0 && (
                      <View style={styles.drivesChip}>
                        <Text style={styles.drivesChipText}>{v.drivesCount} drives</Text>
                      </View>
                    )}
                  </View>
                </View>

                <TouchableOpacity
                  style={styles.menuButton}
                  onPress={() => openActionSheet(v)}
                  accessibilityRole="button"
                  accessibilityLabel={`Options for ${vehicleDisplayName(v)}`}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.menuButtonText}>···</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })
        )}

        {/* Mods & Specs section */}
        {vehicles.length > 0 && (
          <View style={styles.modsSection}>
            <Text style={styles.modsSectionTitle}>Mods & Specs</Text>
            <Text style={styles.modsSectionSubtitle}>Share your build with the convoy</Text>

            {mods.map((mod, i) => (
              <View key={i} style={styles.modRow}>
                <Text style={styles.modBullet}>🔧</Text>
                <Text style={styles.modText}>{mod}</Text>
                <TouchableOpacity onPress={() => void handleRemoveMod(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.modRemove}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}

            {mods.length < 10 && (
              <View style={styles.modInputRow}>
                <TextInput
                  style={styles.modInput}
                  value={newMod}
                  onChangeText={setNewMod}
                  placeholder="e.g. Coilovers, Cat-back exhaust…"
                  placeholderTextColor="#555555"
                  onSubmitEditing={handleAddMod}
                  returnKeyType="done"
                  maxLength={60}
                />
                <TouchableOpacity
                  style={[styles.modAddBtn, !newMod.trim() && { opacity: 0.4 }]}
                  onPress={handleAddMod}
                  disabled={!newMod.trim()}
                >
                  <Text style={styles.modAddBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            )}
            {mods.length === 0 && (
              <Text style={styles.modsEmpty}>No mods added yet. Show your build!</Text>
            )}
          </View>
        )}

        <View style={{ height: 80 }} />
      </ScrollView>

      <TouchableOpacity style={styles.fab} onPress={openAddModal} accessibilityRole="button" accessibilityLabel="Add vehicle">
        <Text style={styles.fabIcon}>+</Text>
      </TouchableOpacity>

      {/* Add / Edit modal */}
      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={closeModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editingId ? 'Edit Vehicle' : 'Add Vehicle'}</Text>
              <TouchableOpacity onPress={closeModal} accessibilityRole="button" accessibilityLabel="Close" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Type pill selector */}
              <View style={styles.formField}>
                <Text style={styles.formLabel}>Type</Text>
                <View style={styles.pillRow}>
                  {VEHICLE_TYPES.map((t) => (
                    <TouchableOpacity
                      key={t}
                      style={[styles.typePill, form.type === t && styles.typePillActive]}
                      onPress={() => setForm((p) => ({ ...p, type: t }))}
                      accessibilityRole="button"
                      accessibilityLabel={t}
                      accessibilityState={{ selected: form.type === t }}
                    >
                      <Text style={[styles.typePillText, form.type === t && styles.typePillTextActive]}>
                        {TYPE_EMOJI[t]} {t}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Make + Model row */}
              <View style={styles.formRow}>
                <View style={[styles.formField, { flex: 1 }]}>
                  <Text style={styles.formLabel}>Make</Text>
                  <TextInput
                    style={styles.formInput}
                    value={form.make}
                    onChangeText={(val) => setForm((p) => ({ ...p, make: val }))}
                    placeholder="Ford"
                    placeholderTextColor="#555555"
                    accessibilityLabel="Vehicle make"
                  />
                </View>
                <View style={[styles.formField, { flex: 1 }]}>
                  <Text style={styles.formLabel}>Model</Text>
                  <TextInput
                    style={styles.formInput}
                    value={form.model}
                    onChangeText={(val) => setForm((p) => ({ ...p, model: val }))}
                    placeholder="Mustang"
                    placeholderTextColor="#555555"
                    accessibilityLabel="Vehicle model"
                  />
                </View>
              </View>

              {/* Name override */}
              <View style={styles.formField}>
                <Text style={styles.formLabel}>Nickname (optional)</Text>
                <TextInput
                  style={styles.formInput}
                  value={form.name}
                  onChangeText={(val) => setForm((p) => ({ ...p, name: val }))}
                  placeholder="My Stang"
                  placeholderTextColor="#555555"
                  accessibilityLabel="Vehicle nickname"
                />
              </View>

              {/* Year */}
              <View style={styles.formField}>
                <Text style={styles.formLabel}>Year</Text>
                <TextInput
                  style={styles.formInput}
                  value={form.year}
                  onChangeText={(val) => setForm((p) => ({ ...p, year: val.replace(/\D/g, '') }))}
                  placeholder="2019"
                  placeholderTextColor="#555555"
                  keyboardType="number-pad"
                  maxLength={4}
                  accessibilityLabel="Vehicle year"
                />
              </View>

              {/* Color picker */}
              <View style={styles.formField}>
                <Text style={styles.formLabel}>Color</Text>
                <View style={styles.colorGrid}>
                  {COLOR_SWATCHES.map((c) => (
                    <TouchableOpacity
                      key={c.name}
                      style={[
                        styles.colorOption,
                        { backgroundColor: c.hex, borderColor: c.hex === '#F0F0F0' ? '#555' : c.hex },
                        form.color === c.name && styles.colorOptionSelected,
                      ]}
                      onPress={() => setForm((p) => ({ ...p, color: p.color === c.name ? '' : c.name }))}
                      accessibilityRole="button"
                      accessibilityLabel={c.name}
                      accessibilityState={{ selected: form.color === c.name }}
                    >
                      {form.color === c.name && <Text style={styles.colorCheck}>✓</Text>}
                    </TouchableOpacity>
                  ))}
                </View>
                {form.color ? <Text style={styles.colorLabel}>{form.color}</Text> : null}
              </View>

              {/* Set as main ride toggle */}
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Set as main ride</Text>
                <Switch
                  value={form.setAsPrimary}
                  onValueChange={(val) => setForm((p) => ({ ...p, setAsPrimary: val }))}
                  trackColor={{ false: '#2A2A2A', true: 'rgba(220,20,60,0.5)' }}
                  thumbColor={form.setAsPrimary ? '#DC143C' : '#555555'}
                  accessibilityLabel="Set as main ride"
                />
              </View>

              {formError ? <Text style={styles.errorText}>{formError}</Text> : null}

              <TouchableOpacity
                style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
                onPress={handleSave}
                disabled={isSaving}
                accessibilityRole="button"
                accessibilityLabel={editingId ? 'Save changes' : 'Add vehicle'}
                accessibilityState={{ disabled: isSaving }}
              >
                {isSaving
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <Text style={styles.saveButtonText}>{editingId ? 'Save Changes' : 'Add Vehicle'}</Text>
                }
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ---------- styles ----------
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  skeletonPad: { padding: 20, paddingTop: 24 },
  scroll: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 48 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 24 },
  title: { fontSize: 28, fontWeight: '700', color: '#F0F0F0' },
  subtitle: { color: '#888888', fontSize: 13 },
  errorText: { color: '#DC143C', fontSize: 13, marginBottom: 12 },

  emptyState: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#FFFFFF', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: '#888888', textAlign: 'center', lineHeight: 22, marginBottom: 32 },
  emptyButton: {
    backgroundColor: '#DC143C', borderRadius: 14, paddingVertical: 16, paddingHorizontal: 40,
    alignItems: 'center', minHeight: 52, justifyContent: 'center',
    shadowColor: '#DC143C', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 6,
  },
  emptyButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  vehicleCard: {
    backgroundColor: '#1C1C1C', borderRadius: 12, borderWidth: 1, borderColor: '#2A2A2A',
    padding: 16, paddingLeft: 20, marginBottom: 12, flexDirection: 'row', alignItems: 'center',
    gap: 12, minHeight: 72, overflow: 'hidden',
  },
  vehicleCardPrimary: { borderColor: 'rgba(220,20,60,0.4)', backgroundColor: '#1F1518' },
  activeStrip: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: '#DC143C' },
  primaryBadge: {
    position: 'absolute', top: 10, right: 12, backgroundColor: 'rgba(220,20,60,0.15)',
    borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: 'rgba(220,20,60,0.3)',
  },
  primaryBadgeText: { color: '#DC143C', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },

  vehicleIconBox: { width: 48, height: 48, borderRadius: 12, backgroundColor: '#141414', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  vehicleIcon: { fontSize: 26 },
  vehicleInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  vehicleName: { fontSize: 18, fontWeight: '700', color: '#FFFFFF', flexShrink: 1 },
  colorSwatch: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, flexShrink: 0 },
  vehicleSubtitle: { fontSize: 14, color: '#888888', marginTop: 3 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  tapToActivate: { fontSize: 11, color: '#555555' },
  drivesChip: { backgroundColor: '#242424', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: '#2A2A2A' },
  drivesChipText: { fontSize: 12, color: '#888888' },
  menuButton: { width: 36, height: 36, borderRadius: 8, backgroundColor: '#242424', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  menuButtonText: { color: '#888888', fontSize: 18, fontWeight: '700', letterSpacing: 2, lineHeight: 20 },

  // Mods section
  modsSection: { marginTop: 28, marginBottom: 8 },
  modsSectionTitle: { fontSize: 18, fontWeight: '700', color: '#F0F0F0', marginBottom: 2 },
  modsSectionSubtitle: { fontSize: 13, color: '#888888', marginBottom: 16 },
  modRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1C', borderRadius: 10, padding: 12, marginBottom: 8, gap: 10 },
  modBullet: { fontSize: 14 },
  modText: { flex: 1, fontSize: 14, color: '#FFFFFF' },
  modRemove: { fontSize: 14, color: '#555555', paddingHorizontal: 4 },
  modInputRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  modInput: {
    flex: 1, backgroundColor: '#1C1C1C', borderRadius: 10, borderWidth: 1, borderColor: '#2A2A2A',
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: '#F0F0F0',
  },
  modAddBtn: {
    width: 48, height: 48, borderRadius: 10, backgroundColor: '#DC143C',
    alignItems: 'center', justifyContent: 'center',
  },
  modAddBtnText: { color: '#FFF', fontSize: 24, fontWeight: '300', lineHeight: 28 },
  modsEmpty: { fontSize: 13, color: '#555555', fontStyle: 'italic', paddingLeft: 4, marginTop: 4 },

  fab: {
    position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#DC143C', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 8,
  },
  fabIcon: { color: '#fff', fontSize: 28, fontWeight: '300', lineHeight: 32 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#1C1C1C', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 48, maxHeight: '90%' },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#2A2A2A', alignSelf: 'center', marginBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#F0F0F0' },
  modalClose: { fontSize: 18, color: '#555555', paddingHorizontal: 4 },
  formField: { marginBottom: 16 },
  formRow: { flexDirection: 'row', gap: 12 },
  formLabel: { fontSize: 13, color: '#888888', marginBottom: 6 },
  formInput: { backgroundColor: '#0A0A0A', borderRadius: 12, borderWidth: 1, borderColor: '#2A2A2A', paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: '#F0F0F0', minHeight: 50 },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typePill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: '#242424', borderWidth: 1, borderColor: '#2A2A2A' },
  typePillActive: { backgroundColor: 'rgba(220,20,60,0.15)', borderColor: '#DC143C' },
  typePillText: { fontSize: 13, color: '#888888', fontWeight: '500' },
  typePillTextActive: { color: '#DC143C', fontWeight: '700' },

  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  colorOption: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  colorOptionSelected: { borderColor: '#FFFFFF', borderWidth: 2.5 },
  colorCheck: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  colorLabel: { fontSize: 12, color: '#888888', marginTop: 6 },

  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingVertical: 4 },
  toggleLabel: { fontSize: 15, color: '#F0F0F0' },

  saveButton: { backgroundColor: '#DC143C', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8, minHeight: 52, justifyContent: 'center' },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});

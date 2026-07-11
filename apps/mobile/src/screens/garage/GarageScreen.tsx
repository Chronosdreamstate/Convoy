import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Platform,
  ScrollView, ActivityIndicator, TextInput, Modal, Alert, RefreshControl, Switch, KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { apiClient } from '../../services/apiClient';
import SkeletonCard from '../../components/SkeletonLoader';
import { useMotionGuard } from '../../hooks/useMotionGuard';
import { useTheme, withAlpha, ThemeColors } from '../../theme';

// ---------- type helpers ----------
type VehicleIconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

// Text/icons that always sit on the crimson accent fill — stays light in both themes.
const ON_ACCENT = '#FFFFFF';

const TYPE_ICON: Record<string, VehicleIconName> = {
  Car: 'car', Truck: 'truck', Motorcycle: 'motorbike', SUV: 'car-estate', Classic: 'car-side', Sports: 'car-sports',
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

// Note: these hex values are actual vehicle-paint swatches (user-selectable
// data), not UI chrome — they are intentionally left as literals rather than
// mapped through useTheme().
function vehicleIconName(v: Vehicle): VehicleIconName {
  if (v.type && TYPE_ICON[v.type]) return TYPE_ICON[v.type];
  const mk = (v.make ?? '').toLowerCase();
  const ml = (v.model ?? '').toLowerCase();
  if (['ferrari','lambo','porsche','mclaren','corvette','mustang','supra','nsx','gtr'].some((k) => mk.includes(k) || ml.includes(k))) return 'car-sports';
  if (['truck','pickup','f-150','silverado','tundra','tacoma','ranger'].some((k) => ml.includes(k)) || mk === 'ram') return 'truck';
  return 'car';
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
  const guardInMotion = useMotionGuard();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [mods, setMods] = useState<string[]>([]);
  const [newMod, setNewMod] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActivating, setIsActivating] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<VehicleForm>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Return-key focus chain across the add/edit form: Make → Model → Nickname → Year
  const modelInputRef = useRef<TextInput>(null);
  const nicknameInputRef = useRef<TextInput>(null);
  const yearInputRef = useRef<TextInput>(null);

  const loadVehicles = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<{ vehicles: Vehicle[]; mods?: string[] }>('/api/v1/vehicles');
      setVehicles(res.data.vehicles);
      if (res.data.mods) setMods(res.data.mods);
    } catch { setError('Failed to load garage. Please try again.'); }
    finally { if (!silent) setIsLoading(false); }
  }, []);

  useEffect(() => { void loadVehicles(); }, [loadVehicles]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadVehicles(true);
    setIsRefreshing(false);
  }, [loadVehicles]);

  const openAddModal = () => {
    // Req 34 — block the add-vehicle form entry point while in motion
    if (guardInMotion()) return;
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
        setDeletingId(v.id);
        try {
          await apiClient.delete(`/api/v1/vehicles/${v.id}`);
          setVehicles((prev) => prev.filter((veh) => veh.id !== v.id));
        } catch { Alert.alert('Error', 'Failed to delete vehicle.'); }
        finally { setDeletingId(null); }
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
    // Native Alert button labels are rendered by the OS, not our React tree —
    // they can't host a vector-icon component, so these keep their emoji glyphs.
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
    const previous = mods;
    const updated = [...mods, mod];
    setMods(updated);
    setNewMod('');
    try { await apiClient.patch('/api/v1/users/me', { mods: updated }); }
    catch { setMods(previous); setNewMod(mod); Alert.alert('Error', 'Failed to save mod. Please try again.'); }
  };

  const handleRemoveMod = async (index: number) => {
    const previous = mods;
    const updated = mods.filter((_, i) => i !== index);
    setMods(updated);
    try { await apiClient.patch('/api/v1/users/me', { mods: updated }); }
    catch { setMods(previous); Alert.alert('Error', 'Failed to remove mod. Please try again.'); }
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
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={colors.accent} colors={[colors.accent]} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>Garage</Text>
          <Text style={styles.subtitle}>{vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''}</Text>
        </View>

        <TouchableOpacity
          style={styles.fuelLogCard}
          onPress={() => router.push('/fuel')}
          accessibilityRole="button"
          accessibilityLabel="Open fuel log"
        >
          <View style={styles.fuelLogIconBox}>
            <MaterialCommunityIcons name="gas-station" size={22} color={colors.text} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.fuelLogTitle}>Fuel Log</Text>
            <Text style={styles.fuelLogSubtitle}>Track fill-ups, spending & MPG</Text>
          </View>
          <Text style={styles.fuelLogChevron}>›</Text>
        </TouchableOpacity>

        {error && vehicles.length > 0 ? <Text style={styles.errorText}>{error}</Text> : null}

        {vehicles.length === 0 && error ? (
          // Distinct from the true "no vehicles yet" empty state below — a
          // failed load must never be mistaken for an empty garage, or the
          // user might think they need to re-add vehicles they already have.
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="alert-circle-outline" size={64} color={colors.textMuted} style={styles.emptyIcon} />
            <Text style={styles.emptyTitle}>Couldn't load your garage</Text>
            <Text style={styles.emptySubtitle}>{error}</Text>
            <TouchableOpacity style={styles.emptyButton} onPress={() => loadVehicles()} accessibilityRole="button" accessibilityLabel="Retry loading garage">
              <Text style={styles.emptyButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : vehicles.length === 0 ? (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="car" size={64} color={colors.textMuted} style={styles.emptyIcon} />
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
            const isDeleting = deletingId === v.id;
            return (
              <TouchableOpacity
                key={v.id}
                style={[styles.vehicleCard, primary && styles.vehicleCardPrimary, isDeleting && styles.vehicleCardDeleting]}
                onPress={() => void handleSetPrimary(v)}
                onLongPress={() => openActionSheet(v)}
                activeOpacity={primary ? 1 : 0.7}
                disabled={isDeleting}
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
                  <MaterialCommunityIcons name={vehicleIconName(v)} size={26} color={colors.text} />
                </View>

                <View style={styles.vehicleInfo}>
                  <View style={styles.nameRow}>
                    <Text style={styles.vehicleName} numberOfLines={1}>{vehicleDisplayName(v)}</Text>
                    {colorH ? (
                      <View style={[styles.colorSwatch, { backgroundColor: colorH, borderColor: colorH === '#F0F0F0' ? colors.textSubtle : colorH }]} />
                    ) : null}
                  </View>
                  {subtitle ? <Text style={styles.vehicleSubtitle}>{subtitle}</Text> : null}
                  <View style={styles.metaRow}>
                    {!primary && (isActivating === v.id
                      ? <ActivityIndicator color={colors.accent} size="small" />
                      : <Text style={styles.tapToActivate}>Tap to set as main ride</Text>
                    )}
                    {v.drivesCount != null && v.drivesCount > 0 && (
                      <View style={styles.drivesChip}>
                        <Text style={styles.drivesChipText}>{v.drivesCount} drives</Text>
                      </View>
                    )}
                  </View>
                </View>

                {isDeleting ? (
                  <View style={styles.menuButton}>
                    <ActivityIndicator size="small" color={colors.accent} />
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.menuButton}
                    onPress={() => openActionSheet(v)}
                    accessibilityRole="button"
                    accessibilityLabel={`Options for ${vehicleDisplayName(v)}`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <MaterialCommunityIcons name="dots-vertical" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
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
                <MaterialCommunityIcons name="wrench" size={14} color={colors.textMuted} />
                <Text style={styles.modText}>{mod}</Text>
                <TouchableOpacity
                  onPress={() => void handleRemoveMod(i)}
                  hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${mod}`}
                >
                  <MaterialCommunityIcons name="close" size={14} color={colors.textSubtle} />
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
                  placeholderTextColor={colors.textSubtle}
                  onSubmitEditing={handleAddMod}
                  returnKeyType="done"
                  submitBehavior="submit"
                  maxLength={60}
                  accessibilityLabel="New modification"
                />
                <TouchableOpacity
                  style={[styles.modAddBtn, !newMod.trim() && { opacity: 0.4 }]}
                  onPress={handleAddMod}
                  disabled={!newMod.trim()}
                  accessibilityRole="button"
                  accessibilityLabel="Add mod"
                >
                  <MaterialCommunityIcons name="plus" size={22} color={ON_ACCENT} />
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
        <MaterialCommunityIcons name="plus" size={28} color={ON_ACCENT} />
      </TouchableOpacity>

      {/* Add / Edit modal */}
      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={closeModal}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editingId ? 'Edit Vehicle' : 'Add Vehicle'}</Text>
              <TouchableOpacity onPress={closeModal} accessibilityRole="button" accessibilityLabel="Close" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <MaterialCommunityIcons name="close" size={20} color={colors.textSubtle} />
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
                      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                      accessibilityRole="button"
                      accessibilityLabel={t}
                      accessibilityState={{ selected: form.type === t }}
                    >
                      <MaterialCommunityIcons
                        name={TYPE_ICON[t]}
                        size={14}
                        color={form.type === t ? colors.accent : colors.textMuted}
                      />
                      <Text style={[styles.typePillText, form.type === t && styles.typePillTextActive]}>
                        {' '}{t}
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
                    placeholderTextColor={colors.textSubtle}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => modelInputRef.current?.focus()}
                    accessibilityLabel="Vehicle make"
                  />
                </View>
                <View style={[styles.formField, { flex: 1 }]}>
                  <Text style={styles.formLabel}>Model</Text>
                  <TextInput
                    ref={modelInputRef}
                    style={styles.formInput}
                    value={form.model}
                    onChangeText={(val) => setForm((p) => ({ ...p, model: val }))}
                    placeholder="Mustang"
                    placeholderTextColor={colors.textSubtle}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => nicknameInputRef.current?.focus()}
                    accessibilityLabel="Vehicle model"
                  />
                </View>
              </View>

              {/* Name override */}
              <View style={styles.formField}>
                <Text style={styles.formLabel}>Nickname (optional)</Text>
                <TextInput
                  ref={nicknameInputRef}
                  style={styles.formInput}
                  value={form.name}
                  onChangeText={(val) => setForm((p) => ({ ...p, name: val }))}
                  placeholder="My Stang"
                  placeholderTextColor={colors.textSubtle}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => yearInputRef.current?.focus()}
                  accessibilityLabel="Vehicle nickname"
                />
              </View>

              {/* Year */}
              <View style={styles.formField}>
                <Text style={styles.formLabel}>Year</Text>
                <TextInput
                  ref={yearInputRef}
                  style={styles.formInput}
                  value={form.year}
                  onChangeText={(val) => setForm((p) => ({ ...p, year: val.replace(/\D/g, '') }))}
                  placeholder="2019"
                  placeholderTextColor={colors.textSubtle}
                  keyboardType="number-pad"
                  returnKeyType="done"
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
                        { backgroundColor: c.hex, borderColor: c.hex === '#F0F0F0' ? colors.textSubtle : c.hex },
                        form.color === c.name && styles.colorOptionSelected,
                      ]}
                      onPress={() => setForm((p) => ({ ...p, color: p.color === c.name ? '' : c.name }))}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
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
                  trackColor={{ false: colors.border, true: withAlpha(colors.accent, 0.5) }}
                  thumbColor={form.setAsPrimary ? colors.accent : colors.textSubtle}
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
                  ? <ActivityIndicator color={ON_ACCENT} />
                  : <Text style={styles.saveButtonText}>{editingId ? 'Save Changes' : 'Add Vehicle'}</Text>
                }
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ---------- styles ----------
function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    skeletonPad: { padding: 20, paddingTop: 24 },
    scroll: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 48 },

    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 24 },
    title: { fontSize: 28, fontWeight: '700', color: colors.text },
    subtitle: { color: colors.textMuted, fontSize: 13 },
    errorText: { color: colors.error, fontSize: 13, marginBottom: 12 },

    fuelLogCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
      padding: 14, marginBottom: 16,
    },
    fuelLogIconBox: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.cardElevated, alignItems: 'center', justifyContent: 'center' },
    fuelLogTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
    fuelLogSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    fuelLogChevron: { fontSize: 22, color: colors.textSubtle },

    emptyState: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
    emptyIcon: { marginBottom: 16 },
    emptyTitle: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: 8 },
    emptySubtitle: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 22, marginBottom: 32 },
    emptyButton: {
      backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 40,
      alignItems: 'center', minHeight: 52, justifyContent: 'center',
      shadowColor: colors.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 6,
    },
    emptyButtonText: { color: ON_ACCENT, fontSize: 16, fontWeight: '700' },

    vehicleCard: {
      backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
      padding: 16, paddingLeft: 20, marginBottom: 12, flexDirection: 'row', alignItems: 'center',
      gap: 12, minHeight: 72, overflow: 'hidden',
    },
    vehicleCardPrimary: { borderColor: withAlpha(colors.accent, 0.4), backgroundColor: colors.cardElevated },
    vehicleCardDeleting: { opacity: 0.5 },
    activeStrip: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: colors.accent },
    primaryBadge: {
      // right: 60 clears the 36px-wide menuButton (right padding 16 + width 36 = 52),
      // leaving an 8px gap so the "MAIN RIDE" chip never sits on top of the "···" button.
      position: 'absolute', top: 10, right: 60, backgroundColor: withAlpha(colors.accent, 0.15),
      borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: withAlpha(colors.accent, 0.3),
    },
    primaryBadgeText: { color: colors.accent, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },

    vehicleIconBox: { width: 48, height: 48, borderRadius: 12, backgroundColor: colors.cardElevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    vehicleInfo: { flex: 1 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    vehicleName: { fontSize: 18, fontWeight: '700', color: colors.text, flexShrink: 1 },
    colorSwatch: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, flexShrink: 0 },
    vehicleSubtitle: { fontSize: 14, color: colors.textMuted, marginTop: 3 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
    tapToActivate: { fontSize: 11, color: colors.textSubtle },
    drivesChip: { backgroundColor: colors.cardElevated, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: colors.border },
    drivesChipText: { fontSize: 12, color: colors.textMuted },
    menuButton: { width: 36, height: 36, borderRadius: 8, backgroundColor: colors.cardElevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },

    // Mods section
    modsSection: { marginTop: 28, marginBottom: 8 },
    modsSectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 2 },
    modsSectionSubtitle: { fontSize: 13, color: colors.textMuted, marginBottom: 16 },
    modRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 10, padding: 12, marginBottom: 8, gap: 10 },
    modText: { flex: 1, fontSize: 14, color: colors.text },
    modInputRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
    modInput: {
      flex: 1, backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
      paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: colors.text,
    },
    modAddBtn: {
      width: 48, height: 48, borderRadius: 10, backgroundColor: colors.accent,
      alignItems: 'center', justifyContent: 'center',
    },
    modsEmpty: { fontSize: 13, color: colors.textSubtle, fontStyle: 'italic', paddingLeft: 4, marginTop: 4 },

    fab: {
      position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28,
      backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
      shadowColor: colors.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 8,
    },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 48, maxHeight: '90%' },
    modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 20 },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    modalTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
    formField: { marginBottom: 16 },
    formRow: { flexDirection: 'row', gap: 12 },
    formLabel: { fontSize: 13, color: colors.textMuted, marginBottom: 6 },
    formInput: { backgroundColor: colors.bg, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: colors.text, minHeight: 50 },

    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    typePill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: colors.cardElevated, borderWidth: 1, borderColor: colors.border },
    typePillActive: { backgroundColor: withAlpha(colors.accent, 0.15), borderColor: colors.accent },
    typePillText: { fontSize: 13, color: colors.textMuted, fontWeight: '500' },
    typePillTextActive: { color: colors.accent, fontWeight: '700' },

    colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
    colorOption: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
    colorOptionSelected: { borderColor: colors.text, borderWidth: 2.5 },
    // The check sits on an arbitrary paint swatch, not UI chrome — always-white
    // with a dark shadow reads on every swatch in both themes (colors.text
    // would be a black check on the Black/Brown swatches in light mode).
    colorCheck: { color: ON_ACCENT, fontSize: 14, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
    colorLabel: { fontSize: 12, color: colors.textMuted, marginTop: 6 },

    toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingVertical: 4 },
    toggleLabel: { fontSize: 15, color: colors.text },

    saveButton: { backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8, minHeight: 52, justifyContent: 'center' },
    saveButtonDisabled: { opacity: 0.5 },
    saveButtonText: { color: ON_ACCENT, fontSize: 16, fontWeight: '700' },
  });
}

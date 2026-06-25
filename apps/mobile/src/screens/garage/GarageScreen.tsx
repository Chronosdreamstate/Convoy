import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Modal,
  Alert,
  RefreshControl,
} from 'react-native';
import { apiClient } from '../../services/apiClient';

const COLOR_MAP: Record<string, string> = {
  'black': '#1a1a1a', 'white': '#f5f5f5', 'silver': '#c0c0c0', 'gray': '#808080',
  'grey': '#808080', 'red': '#DC143C', 'blue': '#1d4ed8', 'navy': '#1e3a5f',
  'green': '#15803d', 'yellow': '#eab308', 'orange': '#ea580c', 'brown': '#92400e',
  'gold': '#d97706', 'bronze': '#b45309', 'purple': '#7c3aed', 'pink': '#ec4899',
  'maroon': '#7f1d1d', 'teal': '#0d9488', 'copper': '#b87333', 'charcoal': '#36454f',
  'agate': '#444444', 'pearl': '#f0ede0', 'cream': '#fffdd0', 'beige': '#f5f5dc',
};

function colorSwatch(colorName: string | null): string | null {
  if (!colorName) return null;
  const lower = colorName.toLowerCase();
  for (const [key, hex] of Object.entries(COLOR_MAP)) {
    if (lower.includes(key)) return hex;
  }
  return null;
}

interface Vehicle {
  id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  photoUrl: string | null;
  isActive: boolean;
  createdAt: string;
}

interface VehicleForm {
  year: string;
  make: string;
  model: string;
  color: string;
}

const EMPTY_FORM: VehicleForm = { year: '', make: '', model: '', color: '' };

function vehicleLabel(v: Vehicle): string {
  const parts = [v.year, v.make, v.model].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Unnamed vehicle';
}

export default function GarageScreen() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActivating, setIsActivating] = useState<string | null>(null);

  // Form modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<VehicleForm>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    void loadVehicles();
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadVehicles(true);
    setIsRefreshing(false);
  }, []);

  const loadVehicles = async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<{ vehicles: Vehicle[] }>('/api/v1/vehicles');
      setVehicles(response.data.vehicles);
    } catch {
      setError('Failed to load garage. Please try again.');
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  const openAddModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalVisible(true);
  };

  const openEditModal = (v: Vehicle) => {
    setEditingId(v.id);
    setForm({
      year: v.year != null ? String(v.year) : '',
      make: v.make ?? '',
      model: v.model ?? '',
      color: v.color ?? '',
    });
    setFormError(null);
    setModalVisible(true);
  };

  const closeModal = () => {
    setModalVisible(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleSave = async () => {
    setFormError(null);

    const yearNum = form.year ? parseInt(form.year, 10) : null;
    if (form.year.trim() && (isNaN(yearNum!) || yearNum! < 1885 || yearNum! > new Date().getFullYear() + 1)) {
      setFormError(`Enter a valid year between 1885 and ${new Date().getFullYear() + 1}.`);
      return;
    }

    const payload = {
      year: yearNum,
      make: form.make.trim() || null,
      model: form.model.trim() || null,
      color: form.color.trim() || null,
    };

    setIsSaving(true);
    try {
      if (editingId) {
        const response = await apiClient.patch<Vehicle>(`/api/v1/vehicles/${editingId}`, payload);
        setVehicles((prev) => prev.map((v) => (v.id === editingId ? response.data : v)));
      } else {
        const response = await apiClient.post<Vehicle>('/api/v1/vehicles', payload);
        setVehicles((prev) => [...prev, response.data]);
      }
      closeModal();
    } catch {
      setFormError('Failed to save vehicle. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = (v: Vehicle) => {
    Alert.alert(
      'Delete Vehicle',
      `Remove "${vehicleLabel(v)}" from your Garage?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiClient.delete(`/api/v1/vehicles/${v.id}`);
              setVehicles((prev) => prev.filter((veh) => veh.id !== v.id));
            } catch {
              Alert.alert('Error', 'Failed to delete vehicle.');
            }
          },
        },
      ],
    );
  };

  const handleActivate = async (v: Vehicle) => {
    if (v.isActive || isActivating) return;
    setIsActivating(v.id);
    try {
      const response = await apiClient.post<Vehicle>(`/api/v1/vehicles/${v.id}/activate`);
      setVehicles((prev) =>
        prev.map((veh) => ({
          ...veh,
          isActive: veh.id === response.data.id,
        })),
      );
    } catch {
      Alert.alert('Error', 'Failed to activate vehicle.');
    } finally {
      setIsActivating(null);
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#DC143C" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#DC143C"
            colors={['#DC143C']}
          />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>Garage</Text>
          <Text style={styles.subtitle}>{vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''}</Text>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {vehicles.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🔧</Text>
            <Text style={styles.emptyTitle}>Add your first vehicle</Text>
            <Text style={styles.emptySubtitle}>
              Add your vehicles so convoy members can see what you're driving.
            </Text>
          </View>
        ) : (
          vehicles.map((v) => (
            <TouchableOpacity
              key={v.id}
              style={[styles.vehicleCard, v.isActive && styles.vehicleCardActive]}
              onPress={() => handleActivate(v)}
              accessibilityRole="button"
              accessibilityLabel={`${vehicleLabel(v)}${v.isActive ? ', active' : ', tap to activate'}`}
            >
              {/* Car emoji icon */}
              <View style={styles.vehicleIconBox}>
                <Text style={styles.vehicleIcon}>🚗</Text>
              </View>

              <View style={styles.vehicleInfo}>
                <View style={styles.vehicleNameRow}>
                  {v.isActive && (
                    <View style={styles.activeBadge}>
                      <Text style={styles.activeBadgeText}>ACTIVE</Text>
                    </View>
                  )}
                  <Text style={styles.vehicleName}>{vehicleLabel(v)}</Text>
                </View>
                {v.color ? (
                  <View style={styles.colorRow}>
                    {colorSwatch(v.color) ? (
                      <View style={[styles.colorSwatch, { backgroundColor: colorSwatch(v.color)! }]} />
                    ) : null}
                    <Text style={styles.vehicleDetail}>{v.color}</Text>
                  </View>
                ) : null}
                {!v.isActive && (
                  isActivating === v.id
                    ? <ActivityIndicator color="#DC143C" size="small" style={{ marginTop: 3 }} />
                    : <Text style={styles.tapToActivate}>Tap to set active</Text>
                )}
              </View>

              <View style={styles.vehicleActions}>
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => openEditModal(v)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${vehicleLabel(v)}`}
                >
                  <Text style={styles.actionButtonText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionButton, styles.deleteButton]}
                  onPress={() => handleDelete(v)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${vehicleLabel(v)}`}
                >
                  <Text style={styles.deleteButtonText}>Delete</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))
        )}

        {/* Bottom padding so FAB doesn't overlap last card */}
        <View style={{ height: 80 }} />
      </ScrollView>

      {/* FAB — Add Vehicle */}
      <TouchableOpacity
        style={styles.fab}
        onPress={openAddModal}
        accessibilityRole="button"
        accessibilityLabel="Add vehicle"
      >
        <Text style={styles.fabIcon}>+</Text>
      </TouchableOpacity>

      {/* Add / Edit Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingId ? 'Edit Vehicle' : 'Add Vehicle'}
              </Text>
              <TouchableOpacity
                onPress={closeModal}
                accessibilityLabel="Close"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {[
                { label: 'Year', key: 'year' as const, placeholder: 'e.g. 2022', keyboardType: 'numeric' as const },
                { label: 'Make', key: 'make' as const, placeholder: 'e.g. Ford' },
                { label: 'Model', key: 'model' as const, placeholder: 'e.g. Bronco' },
                { label: 'Colour', key: 'color' as const, placeholder: 'e.g. Agate Black' },
              ].map((field) => (
                <View key={field.key} style={styles.formField}>
                  <Text style={styles.formLabel}>{field.label}</Text>
                  <TextInput
                    style={styles.formInput}
                    value={form[field.key]}
                    onChangeText={(val) => setForm((prev) => ({ ...prev, [field.key]: val }))}
                    placeholder={field.placeholder}
                    placeholderTextColor="#555555"
                    keyboardType={field.keyboardType}
                    accessibilityLabel={`${field.label} input`}
                  />
                </View>
              ))}

              {formError ? <Text style={styles.errorText}>{formError}</Text> : null}

              <TouchableOpacity
                style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
                onPress={handleSave}
                disabled={isSaving}
                accessibilityRole="button"
                accessibilityLabel={editingId ? 'Save changes' : 'Add vehicle'}
              >
                {isSaving ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.saveButtonText}>
                    {editingId ? 'Save Changes' : 'Add Vehicle'}
                  </Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 48 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 24,
  },
  title: { fontSize: 28, fontWeight: '700', color: '#F0F0F0' },
  subtitle: { color: '#888888', fontSize: 13 },

  errorText: { color: '#DC143C', fontSize: 13, marginBottom: 12 },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#F0F0F0', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: '#888888', textAlign: 'center', lineHeight: 22 },

  // Vehicle card
  vehicleCard: {
    backgroundColor: '#1C1C1C',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 72,
  },
  vehicleCardActive: { borderColor: '#DC143C', borderWidth: 2 },

  vehicleIconBox: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#141414',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  vehicleIcon: { fontSize: 26 },

  vehicleInfo: { flex: 1 },
  vehicleNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  activeBadge: {
    backgroundColor: '#DC143C',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  activeBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  vehicleName: { fontSize: 16, fontWeight: '600', color: '#F0F0F0' },
  vehicleDetail: { fontSize: 13, color: '#888888', marginTop: 2 },
  tapToActivate: { fontSize: 11, color: '#555555', marginTop: 3 },

  vehicleActions: { flexDirection: 'row', gap: 8, flexShrink: 0 },
  actionButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2A2A2A',
    minWidth: 48,
    alignItems: 'center',
    minHeight: 36,
    justifyContent: 'center',
  },
  actionButtonText: { color: '#F0F0F0', fontSize: 13, fontWeight: '600' },
  deleteButton: { backgroundColor: '#1A0505' },
  deleteButtonText: { color: '#DC143C', fontSize: 13, fontWeight: '600' },
  colorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  colorSwatch: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: '#3A3A3A' },

  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#DC143C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  fabIcon: { color: '#fff', fontSize: 28, fontWeight: '300', lineHeight: 32 },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 48,
    maxHeight: '85%',
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#2A2A2A',
    alignSelf: 'center',
    marginBottom: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#F0F0F0' },
  modalClose: { fontSize: 18, color: '#555555', paddingHorizontal: 4 },
  formField: { marginBottom: 16 },
  formLabel: { fontSize: 13, color: '#888888', marginBottom: 6 },
  formInput: {
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#F0F0F0',
    minHeight: 50,
  },
  saveButton: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    minHeight: 52,
    justifyContent: 'center',
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});

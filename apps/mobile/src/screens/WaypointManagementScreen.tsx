import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { theme } from '../theme';

// ─── Types ───────────────────────────────────────────────────────────────────

type WaypointType = 'waypoint' | 'photo_stop' | 'fuel' | 'rest';

interface Waypoint {
  id: string;
  name: string;
  address: string;
  type?: WaypointType;
  lat?: number;
  lng?: number;
}

// ─── Waypoint type definitions ────────────────────────────────────────────────

const WAYPOINT_TYPES: { key: WaypointType; label: string; icon: string }[] = [
  { key: 'waypoint',   label: 'Stop',  icon: '📍' },
  { key: 'photo_stop', label: 'Photo', icon: '📸' },
  { key: 'fuel',       label: 'Fuel',  icon: '⛽' },
  { key: 'rest',       label: 'Rest',  icon: '🅿️' },
];

function getTypeConfig(type?: WaypointType) {
  return WAYPOINT_TYPES.find((t) => t.key === type) ?? WAYPOINT_TYPES[0];
}

// ─── ID helper ────────────────────────────────────────────────────────────────

let _nextId = 1;
function makeId() { return String(_nextId++); }

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function WaypointManagementScreen() {
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const router = useRouter();

  const [waypoints, setWaypoints]       = useState<Waypoint[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [draftName, setDraftName]       = useState('');
  const [draftAddress, setDraftAddress] = useState('');
  const [draftType, setDraftType]       = useState<WaypointType>('waypoint');
  const [saving, setSaving]             = useState(false);

  // ── Reorder / remove ────────────────────────────────────────────────────────

  const moveUp = (index: number) => {
    if (index === 0) return;
    setWaypoints((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveDown = (index: number) => {
    setWaypoints((prev) => {
      if (index === prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  const remove = (id: string) => {
    setWaypoints((prev) => prev.filter((w) => w.id !== id));
  };

  // ── Modal helpers ────────────────────────────────────────────────────────────

  const openModal = () => {
    setDraftName('');
    setDraftAddress('');
    setDraftType('waypoint');
    setModalVisible(true);
  };

  const addWaypoint = () => {
    const name = draftName.trim();
    if (!name) return;
    setWaypoints((prev) => [
      ...prev,
      { id: makeId(), name, address: draftAddress.trim() || '', type: draftType },
    ]);
    setModalVisible(false);
  };

  // ── API ──────────────────────────────────────────────────────────────────────

  const loadWaypoints = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await apiClient.get<{ waypoints: Waypoint[] }>(`/api/v1/groups/${groupId}/waypoints`);
      setWaypoints(res.data.waypoints ?? []);
    } catch {
      // Non-fatal — start with empty list if fetch fails
    }
  }, [groupId]);

  useEffect(() => { void loadWaypoints(); }, [loadWaypoints]);

  const broadcast = async () => {
    if (!groupId) { router.back(); return; }
    setSaving(true);
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/waypoints`, {
        waypoints: waypoints.map((w, i) => ({
          name:    w.name,
          address: w.address,
          type:    w.type,
          lat:     w.lat,
          lng:     w.lng,
          order:   i,
        })),
      });
    } catch {
      // Non-fatal — waypoints will sync next time or on reconnect
    } finally {
      setSaving(false);
      router.back();
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Waypoints</Text>
        <View style={styles.backBtn} />
      </View>

      {waypoints.length === 0 ? (
        /* ── Empty state ─────────────────────────────────────────────────────── */
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>🗺️</Text>
          <Text style={styles.emptyTitle}>No waypoints yet</Text>
          <Text style={styles.emptySubtitle}>Add your first stop to plan the route</Text>
          <TouchableOpacity
            style={styles.addCta}
            onPress={openModal}
            accessibilityRole="button"
          >
            <Text style={styles.addCtaText}>+ Add Waypoint</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* ── Waypoint list ────────────────────────────────────────────────── */}
          <FlatList
            data={waypoints}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            renderItem={({ item, index }) => {
              const typeConfig = getTypeConfig(item.type);
              return (
                <View style={styles.row}>
                  {/* Order badge */}
                  <View style={styles.indexBadge}>
                    <Text style={styles.indexText}>{index + 1}</Text>
                  </View>

                  {/* Type icon badge */}
                  <View style={styles.typeBadge}>
                    <Text style={styles.typeBadgeIcon}>{typeConfig.icon}</Text>
                  </View>

                  {/* Info */}
                  <View style={styles.rowInfo}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {typeConfig.icon} {item.name}
                    </Text>
                    <Text style={[styles.rowTypeLabel, { color: theme.colors.accent }]}>
                      {typeConfig.label}
                    </Text>
                    {item.address ? (
                      <Text style={styles.rowAddress} numberOfLines={1}>
                        {item.address}
                      </Text>
                    ) : null}
                  </View>

                  {/* Reorder / delete controls */}
                  <View style={styles.controls}>
                    <TouchableOpacity
                      onPress={() => moveUp(index)}
                      disabled={index === 0}
                      style={[styles.arrowBtn, index === 0 && styles.arrowDisabled]}
                      accessibilityRole="button"
                      accessibilityLabel="Move up"
                    >
                      <Text style={styles.arrowText}>↑</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => moveDown(index)}
                      disabled={index === waypoints.length - 1}
                      style={[styles.arrowBtn, index === waypoints.length - 1 && styles.arrowDisabled]}
                      accessibilityRole="button"
                      accessibilityLabel="Move down"
                    >
                      <Text style={styles.arrowText}>↓</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => remove(item.id)}
                      style={styles.removeBtn}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${item.name}`}
                    >
                      <Text style={styles.removeText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
          />

          {/* ── Footer actions ───────────────────────────────────────────────── */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.addBtn}
              onPress={openModal}
              accessibilityRole="button"
            >
              <Text style={styles.addBtnText}>+ Add Waypoint</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.broadcastBtn, saving && styles.savingBtn]}
              onPress={() => { void broadcast(); }}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Broadcast waypoints to group"
            >
              {saving
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.broadcastText}>📡 Broadcast to Group</Text>}
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* ── Add Waypoint Modal ─────────────────────────────────────────────── */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Waypoint</Text>
              <TouchableOpacity
                onPress={() => setModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Type selector pill row */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.typeSelectorScroll}
              contentContainerStyle={styles.typeSelectorContent}
            >
              {WAYPOINT_TYPES.map((t) => {
                const isActive = draftType === t.key;
                return (
                  <TouchableOpacity
                    key={t.key}
                    onPress={() => setDraftType(t.key)}
                    style={[
                      styles.typePill,
                      isActive && styles.typePillActive,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Select type ${t.label}`}
                    accessibilityState={{ selected: isActive }}
                  >
                    <Text style={styles.typePillIcon}>{t.icon}</Text>
                    <Text style={[styles.typePillLabel, isActive && styles.typePillLabelActive]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TextInput
              style={styles.input}
              placeholder="Location name *"
              placeholderTextColor={theme.colors.textSubtle}
              value={draftName}
              onChangeText={setDraftName}
              autoFocus
              returnKeyType="next"
            />
            <TextInput
              style={[styles.input, styles.inputSpaced]}
              placeholder="Address (optional)"
              placeholderTextColor={theme.colors.textSubtle}
              value={draftAddress}
              onChangeText={setDraftAddress}
              returnKeyType="done"
              onSubmitEditing={addWaypoint}
            />

            <TouchableOpacity
              style={[styles.addCta, !draftName.trim() && styles.addCtaDisabled]}
              onPress={addWaypoint}
              disabled={!draftName.trim()}
              accessibilityRole="button"
            >
              <Text style={styles.addCtaText}>Add Stop</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backBtn:  { width: 60 },
  backText: { color: theme.colors.accent, fontSize: 17, fontWeight: '500' },
  title:    { color: theme.colors.text, fontSize: 17, fontWeight: '700' },

  // List
  list: { padding: theme.spacing.md, paddingBottom: 0 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
  },

  // Order badge
  indexBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  indexText: { color: theme.colors.text, fontSize: 13, fontWeight: '700' },

  // Type icon badge
  typeBadge: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.accent + '22',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  typeBadgeIcon: { fontSize: 18 },

  // Row info
  rowInfo:      { flex: 1, marginRight: 8 },
  rowName:      { color: theme.colors.text, fontSize: 15, fontWeight: '700' },
  rowTypeLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowAddress: { color: theme.colors.textMuted, fontSize: 13, marginTop: 2 },

  // Controls
  controls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  arrowBtn: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowDisabled: { opacity: 0.3 },
  arrowText:     { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  removeBtn: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
    backgroundColor: '#3A0A14',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  removeText: { color: theme.colors.accent, fontSize: 15, fontWeight: '700' },

  separator: { height: 8 },

  // Footer
  footer: { padding: theme.spacing.md, gap: 10 },
  addBtn: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  addBtnText:    { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  broadcastBtn:  {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  savingBtn:     { opacity: 0.6 },
  broadcastText: { color: theme.colors.text, fontSize: 16, fontWeight: '700' },

  // Empty state
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
  },
  emptyEmoji:    { fontSize: 64, marginBottom: theme.spacing.md },
  emptyTitle:    { color: theme.colors.text, fontSize: 20, fontWeight: '700', marginBottom: theme.spacing.sm },
  emptySubtitle: {
    color: theme.colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
  },
  addCta: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingVertical: 16,
    paddingHorizontal: theme.spacing.xl,
    alignItems: 'center',
    minWidth: 200,
  },
  addCtaDisabled: { opacity: 0.4 },
  addCtaText:     { color: theme.colors.text, fontSize: 16, fontWeight: '700' },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000088',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    padding: theme.spacing.lg,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  modalTitle: { color: theme.colors.text, fontSize: 18, fontWeight: '700' },
  modalClose: { color: theme.colors.textMuted, fontSize: 20, padding: 4 },

  // Type selector
  typeSelectorScroll:   { marginBottom: theme.spacing.md },
  typeSelectorContent:  { gap: 8, paddingRight: 4 },
  typePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: '#2A2A2A',
  },
  typePillActive:      { backgroundColor: '#DC143C', borderColor: '#DC143C' },
  typePillIcon:        { fontSize: 15 },
  typePillLabel:       { fontSize: 14, fontWeight: '600', color: theme.colors.textMuted },
  typePillLabelActive: { color: theme.colors.text },

  // Inputs
  input: {
    backgroundColor: theme.colors.bg,
    borderRadius: theme.radius.sm + 2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 48,
  },
  inputSpaced: { marginTop: 10 },
});

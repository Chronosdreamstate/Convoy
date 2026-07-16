import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { apiClient } from '../services/apiClient';
import { useTheme, withAlpha, ThemeColors } from '../theme';
import { useSocketStore } from '../stores/socketStore';
import { useFuelPrice } from '../hooks/useFuelPrice';
import { useMotionGuard } from '../hooks/useMotionGuard';
import { MAX_WAYPOINTS } from '../services/RouteService';

// ─── Types ───────────────────────────────────────────────────────────────────

type WaypointType = 'waypoint' | 'photo_stop' | 'fuel' | 'rest' | 'food' | 'destination';

interface Waypoint {
  id: string;
  name: string;
  address: string;
  type?: WaypointType;
  lat?: number;
  lng?: number;
}

// ─── Waypoint type definitions ────────────────────────────────────────────────
// `glyph` is a domain category marker (the app's established voice — same idea as
// the emoji used in native Alert copy elsewhere), while `color` is a *semantic
// theme token* so the badge tint stays correct in both light and dark mode.

interface TypeConfig {
  key: WaypointType;
  label: string;
  glyph: string;
  color: keyof ThemeColors;
}

const WAYPOINT_TYPES: TypeConfig[] = [
  { key: 'waypoint',    label: 'Stop',        glyph: '📍', color: 'textMuted' },
  { key: 'photo_stop',  label: 'Photo Stop',  glyph: '📸', color: 'info' },
  { key: 'fuel',        label: 'Fuel Stop',   glyph: '⛽', color: 'warning' },
  { key: 'food',        label: 'Food Stop',   glyph: '🍔', color: 'success' },
  { key: 'rest',        label: 'Rest Stop',   glyph: '🅿️', color: 'info' },
  { key: 'destination', label: 'Destination', glyph: '🏁', color: 'accent' },
];

function getTypeConfig(type?: WaypointType): TypeConfig {
  return WAYPOINT_TYPES.find((t) => t.key === type) ?? WAYPOINT_TYPES[0];
}

// ─── ID helper ────────────────────────────────────────────────────────────────
// Prefixed + monotonic so locally-added rows can never collide with a numeric
// server id (which would break FlatList keys and reorder/remove targeting).

let _nextId = 1;
function makeId() { return `local-${_nextId++}`; }

// ─── WaypointRow ─────────────────────────────────────────────────────────────
// Extracted so that useFuelPrice (a hook) can be called per-item.

interface WaypointRowProps {
  item: Waypoint;
  index: number;
  total: number;
  reachedIds: Set<string>;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onMoveUp: (i: number) => void;
  onMoveDown: (i: number) => void;
  onRemove: (id: string) => void;
  onMarkReached: (w: Waypoint) => void;
}

const ICON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

function WaypointRow({
  item,
  index,
  total,
  reachedIds,
  colors,
  styles,
  onMoveUp,
  onMoveDown,
  onRemove,
  onMarkReached,
}: WaypointRowProps) {
  const typeConfig = getTypeConfig(item.type);
  const typeColor  = colors[typeConfig.color];
  const reached    = reachedIds.has(item.id);
  const fuelPrice  = useFuelPrice(item.type ?? '');
  const isFirst    = index === 0;
  const isLast     = index === total - 1;

  return (
    <View style={styles.row}>
      {/* Order badge */}
      <View style={styles.indexBadge}>
        <Text style={styles.indexText}>{index + 1}</Text>
      </View>

      {/* Type badge — semantic-tinted category marker */}
      <View style={[styles.typeBadge, { backgroundColor: withAlpha(typeColor, 0.16) }]}>
        <Text style={styles.typeBadgeGlyph}>{typeConfig.glyph}</Text>
      </View>

      {/* Info — name/address prioritized */}
      <View style={styles.rowInfo}>
        <Text style={[styles.rowName, reached && styles.rowNameReached]} numberOfLines={1}>
          {item.name}
        </Text>
        {item.address ? (
          <Text style={styles.rowAddress} numberOfLines={1}>
            {item.address}
          </Text>
        ) : null}

        <Text style={[styles.rowTypeLabel, { color: typeColor }]} numberOfLines={1}>
          {typeConfig.label}
        </Text>

        {/* Fuel price estimate */}
        {fuelPrice ? (
          <View style={styles.fuelPill}>
            <Ionicons name="pricetag-outline" size={11} color={colors.success} />
            <Text style={styles.fuelPillText}>
              ~${fuelPrice.pricePerLitre}/L · estimate only
            </Text>
          </View>
        ) : null}

        {/* Mark reached */}
        <TouchableOpacity
          onPress={() => onMarkReached(item)}
          disabled={reached}
          style={[styles.reachedBtn, reached && styles.reachedBtnDone]}
          accessibilityRole="button"
          accessibilityLabel={reached ? `${item.name} reached` : `Mark ${item.name} as reached`}
          accessibilityState={{ disabled: reached }}
        >
          <Ionicons
            name={reached ? 'checkmark-circle' : 'checkmark-circle-outline'}
            size={13}
            color={reached ? colors.success : colors.accent}
          />
          <Text style={[styles.reachedBtnText, reached && styles.reachedBtnTextDone]}>
            {reached ? 'Reached' : 'Mark reached'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Reorder / delete controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          onPress={() => onMoveUp(index)}
          disabled={isFirst}
          style={[styles.ctrlBtn, isFirst && styles.ctrlDisabled]}
          hitSlop={ICON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={`Move ${item.name} up`}
          accessibilityState={{ disabled: isFirst }}
        >
          <Ionicons name="chevron-up" size={18} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onMoveDown(index)}
          disabled={isLast}
          style={[styles.ctrlBtn, isLast && styles.ctrlDisabled]}
          hitSlop={ICON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={`Move ${item.name} down`}
          accessibilityState={{ disabled: isLast }}
        >
          <Ionicons name="chevron-down" size={18} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onRemove(item.id)}
          style={styles.removeBtn}
          hitSlop={ICON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.name}`}
        >
          <Ionicons name="trash-outline" size={17} color={colors.accent} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function WaypointManagementScreen() {
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const socket = useSocketStore((s) => s.socket);
  const guardInMotion = useMotionGuard();

  const [waypoints, setWaypoints]       = useState<Waypoint[]>([]);
  const [loading, setLoading]           = useState(true);
  const [loadError, setLoadError]       = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [draftName, setDraftName]       = useState('');
  const [draftAddress, setDraftAddress] = useState('');
  const [draftType, setDraftType]       = useState<WaypointType>('waypoint');
  const [saving, setSaving]             = useState(false);
  const [saveError, setSaveError]       = useState(false);
  const [reachedIds, setReachedIds]     = useState<Set<string>>(new Set());

  // Req 6.4 — cap the number of waypoints per route.
  const atMaxWaypoints = waypoints.length >= MAX_WAYPOINTS;

  // Req 33 — while the vehicle is in motion, cap the list to 4 waypoints with
  // a "pull over to see more" notice (Req 34's useMotionGuard already blocks
  // the *add* flow above; this limits scrolling the existing stops mid-drive).
  // The cap keeps the first 4 rows of `waypoints`, so each visible row's
  // `index` still addresses the same slot in the full array — moveUp/moveDown
  // and the row's isLast check (driven by the full `waypoints.length` via
  // `total`) stay correct while capped.
  const { data: visibleWaypoints, hiddenCount: hiddenWaypointCount } = useMotionCappedData(waypoints);

  // ── Reorder / remove ────────────────────────────────────────────────────────

  const moveUp = useCallback((index: number) => {
    if (index === 0) return;
    setWaypoints((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const moveDown = useCallback((index: number) => {
    setWaypoints((prev) => {
      if (index === prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setWaypoints((prev) => prev.filter((w) => w.id !== id));
  }, []);

  // ── Mark waypoint reached ────────────────────────────────────────────────────

  const markReached = useCallback((waypoint: Waypoint) => {
    if (reachedIds.has(waypoint.id)) return;
    setReachedIds((prev) => new Set([...prev, waypoint.id]));
    if (!socket || !groupId) return;
    const isPhotoStop = waypoint.type === 'photo_stop';
    socket.emit('waypoint:reached', {
      waypointId: waypoint.id,
      type: waypoint.type ?? 'waypoint',
      groupId,
      message: isPhotoStop
        ? '📸 Photo stop! Take a moment to capture the view.'
        : `📍 Reached: ${waypoint.name}`,
    });
  }, [socket, groupId, reachedIds]);

  // ── Modal helpers ────────────────────────────────────────────────────────────

  const openModal = () => {
    // Req 34 — block the add-waypoint form entry point while in motion
    if (guardInMotion()) return;
    // Req 6.4 — block the add-waypoint form entry point once at the cap
    if (atMaxWaypoints) {
      Alert.alert(
        'Waypoint limit reached',
        `You can add up to ${MAX_WAYPOINTS} waypoints per route.`,
      );
      return;
    }
    setDraftName('');
    setDraftAddress('');
    setDraftType('waypoint');
    setModalVisible(true);
  };

  const addWaypoint = () => {
    const name = draftName.trim();
    if (!name) return;
    // Req 6.4 — defend against adding past the cap (e.g. the modal was
    // already open when the last free slot was used).
    if (atMaxWaypoints) {
      setModalVisible(false);
      Alert.alert(
        'Waypoint limit reached',
        `You can add up to ${MAX_WAYPOINTS} waypoints per route.`,
      );
      return;
    }
    setWaypoints((prev) => [
      ...prev,
      { id: makeId(), name, address: draftAddress.trim() || '', type: draftType },
    ]);
    setModalVisible(false);
  };

  // ── API ──────────────────────────────────────────────────────────────────────

  const loadWaypoints = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    setLoading(true);
    setLoadError(false);
    try {
      const res = await apiClient.get<{ waypoints: Waypoint[] }>(`/api/v1/groups/${groupId}/waypoints`);
      setWaypoints(res.data.waypoints ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void loadWaypoints(); }, [loadWaypoints]);

  const broadcast = async () => {
    if (!groupId) { router.back(); return; }
    setSaving(true);
    setSaveError(false);
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
      router.back();
    } catch {
      // Keep the user on-screen with their edits intact so they can retry.
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const renderWaypointItem = useCallback(
    ({ item, index }: { item: Waypoint; index: number }) => (
      <WaypointRow
        item={item}
        index={index}
        total={waypoints.length}
        reachedIds={reachedIds}
        colors={colors}
        styles={styles}
        onMoveUp={moveUp}
        onMoveDown={moveDown}
        onRemove={remove}
        onMarkReached={markReached}
      />
    ),
    [waypoints.length, reachedIds, colors, styles, moveUp, moveDown, remove, markReached],
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={ICON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
        </TouchableOpacity>
        <Text style={styles.title}>Waypoints</Text>
        <View style={styles.backBtn} />
      </View>

      {loading ? (
        /* ── Loading ──────────────────────────────────────────────────────────── */
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.centerNote}>Loading route…</Text>
        </View>
      ) : loadError ? (
        /* ── Load error ───────────────────────────────────────────────────────── */
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={colors.textMuted} />
          <Text style={styles.centerTitle}>Couldn’t load waypoints</Text>
          <Text style={styles.centerNote}>Check your connection and try again.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => { void loadWaypoints(); }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading waypoints"
          >
            <Ionicons name="refresh" size={16} color={colors.text} />
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : waypoints.length === 0 ? (
        /* ── Empty state ──────────────────────────────────────────────────────── */
        <View style={styles.center}>
          <Ionicons name="map-outline" size={48} color={colors.textMuted} />
          <Text style={styles.centerTitle}>No waypoints yet</Text>
          <Text style={styles.centerNote}>Add your first stop to start planning the route.</Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={openModal}
            accessibilityRole="button"
            accessibilityLabel="Add your first waypoint"
          >
            <Ionicons name="add" size={18} color={ON_ACCENT} />
            <Text style={styles.primaryBtnText}>Add waypoint</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* ── Waypoint list ────────────────────────────────────────────────── */}
          <FlatList
            data={visibleWaypoints}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            renderItem={renderWaypointItem}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListFooterComponent={<MotionCapNotice hiddenCount={hiddenWaypointCount} />}
            showsVerticalScrollIndicator={false}
          />

          {/* ── Footer actions ───────────────────────────────────────────────── */}
          <View style={styles.footer}>
            {saveError ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                <Text style={styles.errorBannerText}>
                  Couldn’t broadcast. Your stops are saved locally — tap to retry.
                </Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.secondaryBtn, atMaxWaypoints && styles.btnDisabled]}
              onPress={openModal}
              disabled={saving || atMaxWaypoints}
              accessibilityRole="button"
              accessibilityLabel={
                atMaxWaypoints ? `Waypoint limit of ${MAX_WAYPOINTS} reached` : 'Add waypoint'
              }
              accessibilityState={{ disabled: saving || atMaxWaypoints }}
            >
              <Ionicons name="add" size={18} color={colors.text} />
              <Text style={styles.secondaryBtnText}>
                {atMaxWaypoints ? `Limit reached (${MAX_WAYPOINTS})` : 'Add waypoint'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.primaryBtn, saving && styles.btnBusy]}
              onPress={() => { void broadcast(); }}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Broadcast waypoints to group"
              accessibilityState={{ disabled: saving, busy: saving }}
            >
              {saving ? (
                <>
                  <ActivityIndicator color={ON_ACCENT} size="small" />
                  <Text style={styles.primaryBtnText}>Broadcasting…</Text>
                </>
              ) : (
                <>
                  <Ionicons name={saveError ? 'refresh' : 'megaphone-outline'} size={18} color={ON_ACCENT} />
                  <Text style={styles.primaryBtnText}>
                    {saveError ? 'Retry broadcast' : 'Broadcast to group'}
                  </Text>
                </>
              )}
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
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Add waypoint</Text>
                <TouchableOpacity
                  onPress={() => setModalVisible(false)}
                  hitSlop={ICON_HIT_SLOP}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>

              {/* Type selector pill row */}
              <Text style={styles.fieldLabel}>Stop type</Text>
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
                      style={[styles.typePill, isActive && styles.typePillActive]}
                      accessibilityRole="button"
                      accessibilityLabel={`Set type to ${t.label}`}
                      accessibilityState={{ selected: isActive }}
                    >
                      <Text style={styles.typePillGlyph}>{t.glyph}</Text>
                      <Text style={[styles.typePillLabel, isActive && styles.typePillLabelActive]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <Text style={styles.fieldLabel}>Location name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Cadwell Park paddock"
                placeholderTextColor={colors.textSubtle}
                value={draftName}
                onChangeText={setDraftName}
                autoFocus
                returnKeyType="next"
                accessibilityLabel="Location name"
              />

              <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Address (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="Street, city, or landmark"
                placeholderTextColor={colors.textSubtle}
                value={draftAddress}
                onChangeText={setDraftAddress}
                returnKeyType="done"
                onSubmitEditing={addWaypoint}
                accessibilityLabel="Address"
              />

              <TouchableOpacity
                style={[styles.primaryBtn, styles.modalSubmit, !draftName.trim() && styles.btnDisabled]}
                onPress={addWaypoint}
                disabled={!draftName.trim()}
                accessibilityRole="button"
                accessibilityLabel="Add this stop"
                accessibilityState={{ disabled: !draftName.trim() }}
              >
                <Ionicons name="add" size={18} color={ON_ACCENT} />
                <Text style={styles.primaryBtnText}>Add stop</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// `#FFFFFF` is used for text/icons sitting on the saturated accent fill so it
// stays legible in light mode too (where colors.text is near-black) — the same
// rationale used for on-accent labels across the app.
const ON_ACCENT = '#FFFFFF';

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },

    // Header
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backBtn:  { width: 64, justifyContent: 'center' },
    backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
    title:    { color: colors.text, fontSize: 17, fontWeight: '700' },

    // Centered states (loading / error / empty)
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 8,
    },
    centerTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 8 },
    centerNote:  { color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
    retryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 12,
      paddingHorizontal: 18,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    retryText: { color: colors.text, fontSize: 15, fontWeight: '600' },

    // List
    list: { padding: 16, paddingBottom: 8 },
    separator: { height: 8 },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
    },

    // Order badge
    indexBadge: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    indexText: { color: ON_ACCENT, fontSize: 13, fontWeight: '700' },

    // Type badge
    typeBadge: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    typeBadgeGlyph: { fontSize: 18 },

    // Row info
    rowInfo:  { flex: 1, marginRight: 8 },
    rowName:  { color: colors.text, fontSize: 15, fontWeight: '700' },
    rowAddress: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
    rowTypeLabel: {
      fontSize: 11,
      fontWeight: '700',
      marginTop: 4,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    rowNameReached: { color: colors.textMuted, textDecorationLine: 'line-through' },

    reachedBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginTop: 8,
      alignSelf: 'flex-start',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.accent,
    },
    reachedBtnDone:     { borderColor: colors.success, backgroundColor: withAlpha(colors.success, 0.12) },
    reachedBtnText:     { color: colors.accent, fontSize: 11, fontWeight: '700' },
    reachedBtnTextDone: { color: colors.success },

    // Fuel price estimate
    fuelPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      alignSelf: 'flex-start',
      backgroundColor: withAlpha(colors.success, 0.12),
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginTop: 6,
      borderWidth: 1,
      borderColor: withAlpha(colors.success, 0.3),
    },
    fuelPillText: { color: colors.success, fontSize: 11, fontWeight: '600' },

    // Controls
    controls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    ctrlBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: colors.cardElevated,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctrlDisabled: { opacity: 0.35 },
    removeBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: 'transparent',
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 4,
    },

    // Footer
    footer: {
      padding: 16,
      gap: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: withAlpha(colors.error, 0.12),
      borderWidth: 1,
      borderColor: withAlpha(colors.error, 0.3),
    },
    errorBannerText: { flex: 1, color: colors.error, fontSize: 13, fontWeight: '600' },

    // Buttons
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 20,
      minHeight: 52,
    },
    primaryBtnText: { color: ON_ACCENT, fontSize: 16, fontWeight: '700' },
    secondaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.card,
      borderRadius: 12,
      paddingVertical: 14,
      minHeight: 52,
      borderWidth: 1,
      borderColor: colors.border,
    },
    secondaryBtnText: { color: colors.text, fontSize: 15, fontWeight: '600' },
    btnBusy:     { opacity: 0.7 },
    btnDisabled: { opacity: 0.4 },

    // Modal
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      justifyContent: 'flex-end',
    },
    modalCard: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 24,
      paddingBottom: 40,
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 16,
    },
    modalTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },

    fieldLabel: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    fieldLabelSpaced: { marginTop: 14 },

    // Type selector
    typeSelectorScroll:  { marginBottom: 16 },
    typeSelectorContent: { gap: 8, paddingRight: 4 },
    typePill: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 14,
      height: 38,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
    },
    typePillActive:      { backgroundColor: withAlpha(colors.accent, 0.15), borderColor: colors.accent },
    typePillGlyph:       { fontSize: 15 },
    typePillLabel:       { fontSize: 14, fontWeight: '600', color: colors.textMuted },
    typePillLabelActive: { color: colors.text },

    // Inputs
    input: {
      backgroundColor: colors.bg,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      color: colors.text,
      fontSize: 15,
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 48,
    },

    modalSubmit: { marginTop: 24 },
  });
}

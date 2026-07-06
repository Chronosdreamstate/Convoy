/**
 * HazardReportModal — Full hazard report bottom sheet.
 * Triggered by long-press on map or the FAB hazard button.
 * Requirements: 11.1, 31.1–31.3
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { SQLiteOfflineDB } from '../services/OfflineCacheService';
import { ThemeColors, useTheme } from '../theme';

// Shares the same on-disk SQLite file as MapScreen's offline queue (expo-sqlite
// keys connections by filename), so anything queued here is picked up by the
// same flush-on-reconnect logic (Req 11.9, 11.10).
const offlineDB = new SQLiteOfflineDB();
const offlineDBReady = offlineDB.init().then(() => true).catch(() => false);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Full 9-type grid shown when parked (Req 31.2, mirrors HazardPicker's HAZARD_TYPES).
// Kept as emoji rather than vector icons — same rationale as HazardPicker: instant
// visual recognition of hazard category while driving, matching the map pins.
const ALL_TYPES = [
  { key: 'pothole',    emoji: '🕳️', label: 'Pothole'   },
  { key: 'accident',   emoji: '🚗', label: 'Accident'  },
  { key: 'roadwork',   emoji: '🚧', label: 'Road Work' },
  { key: 'debris',     emoji: '⚠️', label: 'Debris'    },
  { key: 'animal',     emoji: '🐦', label: 'Animal'    },
  { key: 'speed_trap', emoji: '🚔', label: 'Police'    },
  { key: 'ice',        emoji: '🧊', label: 'Ice'       },
  { key: 'flood',      emoji: '🌊', label: 'Flooding'  },
  { key: 'other',      emoji: '❓', label: 'Other'     },
] as const;

type HazardKey = (typeof ALL_TYPES)[number]['key'];
type Severity  = 'low' | 'medium' | 'high';

// In-motion: no more than 6 large touch targets (Req 31.1), and no free-text
// entry (severity/note are hidden below) so nothing requires fine-grained
// typing while driving.
const MOTION_TYPE_KEYS: HazardKey[] = ['roadwork', 'debris', 'animal', 'flood', 'speed_trap', 'other'];

interface Props {
  visible: boolean;
  onClose: () => void;
  /** GPS latitude of the report location (from long-press or current position). */
  lat: number | null;
  /** GPS longitude of the report location. */
  lng: number | null;
  /** True when the vehicle is moving — restricts the picker per Req 31.1/31.2. */
  isInMotion?: boolean;
}

// ---------------------------------------------------------------------------
// HazardReportModal
// ---------------------------------------------------------------------------

export default function HazardReportModal({ visible, onClose, lat, lng, isInMotion = false }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [type,       setType]       = useState<HazardKey | null>(null);
  const [severity,   setSeverity]   = useState<Severity>('medium');
  const [note,       setNote]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(false);

  const visibleTypes = isInMotion
    ? ALL_TYPES.filter((t) => MOTION_TYPE_KEYS.includes(t.key))
    : ALL_TYPES;

  // Reset form when sheet opens
  useEffect(() => {
    if (visible) {
      setType(null);
      setSeverity('medium');
      setNote('');
      setToast(false);
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!type || lat == null || lng == null) return;
    setSubmitting(true);
    try {
      await apiClient.post('/api/v1/hazards', {
        type,
        severity,
        lat,
        lng,
        note: note.trim() || undefined,
      });
      setToast(true);
      setTimeout(() => {
        setToast(false);
        onClose();
      }, 2200);
    } catch {
      // Network/offline failure — queue for sync later (Req 11.9, 11.10) instead of
      // silently dropping the report. Severity isn't carried by the offline queue
      // (POST /hazards/bulk doesn't accept it), so it's lost for queued reports only.
      const ready = await offlineDBReady;
      if (ready) {
        await offlineDB.saveHazard({
          id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          lat,
          lng,
          type,
          description: note.trim() || undefined,
          createdAt: Date.now(),
        }).catch(() => {});
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [type, severity, lat, lng, note, onClose]);

  const locationStr =
    lat != null && lng != null
      ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
      : 'Acquiring GPS…';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={handleClose} accessible={false} />

        <View style={s.sheet}>
          {/* Drag handle */}
          <View style={s.handle} />

          {/* Header */}
          <View style={s.header}>
            <View style={s.spacer} />
            <Text style={s.title}>Report a Hazard</Text>
            <TouchableOpacity
              style={s.closeBtn}
              onPress={handleClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close hazard report"
            >
              <Ionicons name="close" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Type grid — 6 targets while in motion (Req 31.1), full 9 when parked (Req 31.2) */}
          <Text style={s.sectionLabel}>Type</Text>
          <View style={s.grid}>
            {visibleTypes.map(({ key, emoji, label }) => (
              <TouchableOpacity
                key={key}
                style={[s.card, type === key && s.cardOn]}
                onPress={() => setType(type === key ? null : key)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`${emoji} ${label}`}
                accessibilityState={{ selected: type === key }}
              >
                <Text style={s.cardEmoji}>{emoji}</Text>
                <Text style={[s.cardLabel, type === key && s.cardLabelOn]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Severity and free-text note are hidden while in motion (Req 31.1) —
              selecting a severity pill is a minor extra tap, but the note field
              invites exactly the fine-grained typing driver-distraction rules
              are meant to prevent. */}
          {!isInMotion && (
            <>
              <Text style={s.sectionLabel}>Severity</Text>
              <View style={s.pills}>
                {(['low', 'medium', 'high'] as Severity[]).map((sev) => (
                  <TouchableOpacity
                    key={sev}
                    style={[s.pill, severity === sev && s.pillOn]}
                    onPress={() => setSeverity(sev)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={`${sev} severity`}
                    accessibilityState={{ selected: severity === sev }}
                  >
                    <Text style={[s.pillTxt, severity === sev && s.pillTxtOn]}>
                      {sev.charAt(0).toUpperCase() + sev.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.sectionLabel}>Note (optional)</Text>
              <TextInput
                style={s.noteInput}
                placeholder="Add a note…"
                placeholderTextColor={colors.textMuted}
                value={note}
                onChangeText={(t) => setNote(t.slice(0, 100))}
                maxLength={100}
                multiline
                accessibilityLabel="Hazard note"
              />
            </>
          )}

          {/* Location */}
          <Text style={s.sectionLabel}>Your Location</Text>
          <Text style={s.locText}>{locationStr}</Text>

          {/* Submit */}
          <TouchableOpacity
            style={[s.submitBtn, (!type || submitting) && s.submitOff]}
            onPress={handleSubmit}
            disabled={!type || submitting}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Report Hazard"
          >
            <Text style={s.submitTxt}>
              {submitting ? 'Reporting…' : 'Report Hazard'}
            </Text>
          </TouchableOpacity>

          {/* Success toast */}
          {toast && (
            <View style={s.toast}>
              <Text style={s.toastTxt}>
                ✓ Hazard reported — thanks for keeping the convoy safe!
              </Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles — design tokens inline per project convention
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay:     { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
    sheet:       { backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: colors.border, paddingTop: 8, paddingBottom: 36, paddingHorizontal: 20 },
    handle:      { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.textSubtle, marginBottom: 14 },
    header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
    spacer:      { width: 32 },
    title:       { fontSize: 17, fontWeight: '700', color: colors.text, letterSpacing: 0.3 },
    closeBtn:    { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
    sectionLabel:{ fontSize: 11, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
    grid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
    card:        { width: '30%', aspectRatio: 1, borderRadius: 12, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
    // cardOn/pillOn's backgrounds are a fixed dark maroon tint (not a themed
    // surface), so their "on" labels stay fixed white rather than colors.text.
    cardOn:      { backgroundColor: '#250008', borderColor: colors.accent },
    cardEmoji:   { fontSize: 26, marginBottom: 4 },
    cardLabel:   { fontSize: 11, fontWeight: '600', color: colors.textMuted, textAlign: 'center' },
    cardLabelOn: { color: '#FFFFFF' },
    pills:       { flexDirection: 'row', gap: 8, marginBottom: 14 },
    pill:        { flex: 1, paddingVertical: 10, borderRadius: 20, backgroundColor: colors.card, alignItems: 'center', borderWidth: 1.5, borderColor: 'transparent' },
    pillOn:      { backgroundColor: '#250008', borderColor: colors.accent },
    pillTxt:     { fontSize: 14, fontWeight: '600', color: colors.textMuted },
    pillTxtOn:   { color: '#FFFFFF' },
    noteInput:   { backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 14, paddingHorizontal: 12, paddingVertical: 10, minHeight: 58, textAlignVertical: 'top', marginBottom: 12 },
    locText:     { fontSize: 13, color: colors.textMuted, marginBottom: 18, fontVariant: ['tabular-nums'] },
    submitBtn:   { backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 17, alignItems: 'center' },
    submitOff:   { backgroundColor: '#3A0A14' },
    // submitBtn's background is the fixed-value accent color (same in both
    // themes), so its label stays fixed white for contrast.
    submitTxt:   { fontSize: 17, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.3 },
    toast:       { position: 'absolute', left: 20, right: 20, bottom: 44, backgroundColor: '#166534', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
    toastTxt:    { fontSize: 13, fontWeight: '600', color: '#DCFCE7', textAlign: 'center' },
  });
}

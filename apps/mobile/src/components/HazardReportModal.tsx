/**
 * HazardReportModal — Full hazard report bottom sheet.
 * Triggered by long-press on map or the FAB hazard button.
 * Requirements: 11.1, 31.1–31.3
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiClient } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const TYPES = [
  { key: 'roadwork',   emoji: '🚧', label: 'Road Work' },
  { key: 'debris',     emoji: '⚠️', label: 'Debris'    },
  { key: 'animal',     emoji: '🐦', label: 'Animal'    },
  { key: 'flood',      emoji: '🌊', label: 'Flooding'  },
  { key: 'speed_trap', emoji: '🚔', label: 'Police'    },
  { key: 'other',      emoji: '❓', label: 'Other'     },
] as const;

type HazardKey = (typeof TYPES)[number]['key'];
type Severity  = 'low' | 'medium' | 'high';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** GPS latitude of the report location (from long-press or current position). */
  lat: number | null;
  /** GPS longitude of the report location. */
  lng: number | null;
}

// ---------------------------------------------------------------------------
// HazardReportModal
// ---------------------------------------------------------------------------

export default function HazardReportModal({ visible, onClose, lat, lng }: Props) {
  const [type,       setType]       = useState<HazardKey | null>(null);
  const [severity,   setSeverity]   = useState<Severity>('medium');
  const [note,       setNote]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(false);

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
      // Network failure — offline queue in HazardService handles retry
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
        <Pressable style={StyleSheet.absoluteFillObject} onPress={handleClose} />

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
              <Text style={s.closeX}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Type — 2 × 3 grid */}
          <Text style={s.sectionLabel}>Type</Text>
          <View style={s.grid}>
            {TYPES.map(({ key, emoji, label }) => (
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

          {/* Severity */}
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

          {/* Note */}
          <Text style={s.sectionLabel}>Note (optional)</Text>
          <TextInput
            style={s.noteInput}
            placeholder="Add a note…"
            placeholderTextColor="#888888"
            value={note}
            onChangeText={(t) => setNote(t.slice(0, 100))}
            maxLength={100}
            multiline
            accessibilityLabel="Hazard note"
          />

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

const s = StyleSheet.create({
  overlay:     { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet:       { backgroundColor: '#0A0A0A', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: '#2A2A2A', paddingTop: 8, paddingBottom: 36, paddingHorizontal: 20 },
  handle:      { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: '#444444', marginBottom: 14 },
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  spacer:      { width: 32 },
  title:       { fontSize: 17, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.3 },
  closeBtn:    { width: 32, height: 32, borderRadius: 16, backgroundColor: '#1C1C1C', alignItems: 'center', justifyContent: 'center' },
  closeX:      { fontSize: 14, color: '#888888', fontWeight: '600' },
  sectionLabel:{ fontSize: 11, fontWeight: '600', color: '#888888', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
  grid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  card:        { width: '30%', aspectRatio: 1, borderRadius: 12, backgroundColor: '#1C1C1C', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  cardOn:      { backgroundColor: '#250008', borderColor: '#DC143C' },
  cardEmoji:   { fontSize: 26, marginBottom: 4 },
  cardLabel:   { fontSize: 11, fontWeight: '600', color: '#888888', textAlign: 'center' },
  cardLabelOn: { color: '#FFFFFF' },
  pills:       { flexDirection: 'row', gap: 8, marginBottom: 14 },
  pill:        { flex: 1, paddingVertical: 10, borderRadius: 20, backgroundColor: '#1C1C1C', alignItems: 'center', borderWidth: 1.5, borderColor: 'transparent' },
  pillOn:      { backgroundColor: '#250008', borderColor: '#DC143C' },
  pillTxt:     { fontSize: 14, fontWeight: '600', color: '#888888' },
  pillTxtOn:   { color: '#FFFFFF' },
  noteInput:   { backgroundColor: '#1C1C1C', borderRadius: 10, borderWidth: 1, borderColor: '#2A2A2A', color: '#FFFFFF', fontSize: 14, paddingHorizontal: 12, paddingVertical: 10, minHeight: 58, textAlignVertical: 'top', marginBottom: 12 },
  locText:     { fontSize: 13, color: '#888888', marginBottom: 18, fontVariant: ['tabular-nums'] },
  submitBtn:   { backgroundColor: '#DC143C', borderRadius: 14, paddingVertical: 17, alignItems: 'center' },
  submitOff:   { backgroundColor: '#3A0A14' },
  submitTxt:   { fontSize: 17, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.3 },
  toast:       { position: 'absolute', left: 20, right: 20, bottom: 44, backgroundColor: '#166534', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  toastTxt:    { fontSize: 13, fontWeight: '600', color: '#DCFCE7', textAlign: 'center' },
});

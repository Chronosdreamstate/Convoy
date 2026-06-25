/**
 * HazardPicker — Hazard type selection sheet (Req 31.1–31.3)
 * Full 9-type grid when parked; max 6 large targets when in motion.
 */

import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { HAZARD_TYPES, HazardType } from '../services/HazardService';

// ---------------------------------------------------------------------------
// Label / emoji mapping for display
// ---------------------------------------------------------------------------

const HAZARD_LABELS: Record<HazardType, { label: string; emoji: string }> = {
  pothole:    { label: 'Pothole',    emoji: '🕳️' },
  accident:   { label: 'Accident',   emoji: '🚗' },
  roadwork:   { label: 'Roadwork',   emoji: '🚧' },
  debris:     { label: 'Debris',     emoji: '🪨' },
  animal:     { label: 'Animal',     emoji: '🦌' },
  speed_trap: { label: 'Speed Trap', emoji: '📷' },
  ice:        { label: 'Ice',        emoji: '🧊' },
  flood:      { label: 'Flood',      emoji: '🌊' },
  other:      { label: 'Other',      emoji: '⚠️' },
};

// In-motion: show 6 highest-priority types with larger tap targets (Req 31.2)
const MOTION_TYPES: HazardType[] = [
  'pothole', 'accident', 'roadwork', 'debris', 'animal', 'speed_trap',
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  visible: boolean;
  /** True when the vehicle is moving (speed_kph > 0). */
  isInMotion: boolean;
  onSelect: (type: HazardType) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HazardPicker({ visible, isInMotion, onSelect, onClose }: Props) {
  const types = isInMotion
    ? MOTION_TYPES          // 6 large targets while moving (Req 31.2)
    : [...HAZARD_TYPES];    // All 9 types when parked (Req 31.1)

  const tileSize = isInMotion ? styles.tileLarge : styles.tileNormal;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>Report a Hazard</Text>
          <View style={styles.grid}>
            {types.map((type) => {
              const { label, emoji } = HAZARD_LABELS[type];
              return (
                <TouchableOpacity
                  key={type}
                  style={[styles.tile, tileSize]}
                  onPress={() => { onSelect(type); onClose(); }}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`${emoji} ${label}`}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                  <Text style={styles.label}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const TILE_NORMAL = 90;
const TILE_LARGE = 120;

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingTop: 8,
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#555555',
    marginBottom: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F0F0F0',
    textAlign: 'center',
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
  },
  tile: {
    borderRadius: 12,
    backgroundColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  tileNormal: {
    width: TILE_NORMAL,
    height: TILE_NORMAL,
  },
  tileLarge: {
    width: TILE_LARGE,
    height: TILE_LARGE,
  },
  emoji: {
    fontSize: 28,
    marginBottom: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: '#F0F0F0',
    textAlign: 'center',
  },
  cancel: {
    marginTop: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#DC143C',
  },
});

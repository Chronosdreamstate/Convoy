/**
 * HazardPicker — Hazard type selection sheet (Req 31.1–31.3)
 * Full 9-type grid when parked; max 6 large targets when in motion.
 * Select a type, then confirm with the full-width button.
 */

import React, { useRef, useState } from 'react';
import {
  Animated,
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
// HazardCard — animated square card for each hazard type
// ---------------------------------------------------------------------------

interface CardProps {
  type: HazardType;
  label: string;
  emoji: string;
  isSelected: boolean;
  size: number;
  onPress: () => void;
}

function HazardCard({ label, emoji, isSelected, size, onPress }: CardProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.92, duration: 70, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 24, bounciness: 5 }),
    ]).start();
    onPress();
  };

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        style={[
          styles.card,
          { width: size, height: size },
          isSelected && styles.cardSelected,
        ]}
        onPress={handlePress}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`${emoji} ${label}`}
        accessibilityState={{ selected: isSelected }}
      >
        <Text style={styles.cardEmoji}>{emoji}</Text>
        <Text style={[styles.cardLabel, isSelected && styles.cardLabelSelected]}>
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// HazardPicker
// ---------------------------------------------------------------------------

export default function HazardPicker({ visible, isInMotion, onSelect, onClose }: Props) {
  const [selectedType, setSelectedType] = useState<HazardType | null>(null);

  const types = isInMotion
    ? MOTION_TYPES          // 6 large targets while moving (Req 31.2)
    : [...HAZARD_TYPES];    // All 9 types when parked (Req 31.1)

  const cardSize = isInMotion ? 100 : 80;

  const handleClose = () => {
    setSelectedType(null);
    onClose();
  };

  const handleConfirm = () => {
    if (!selectedType) return;
    onSelect(selectedType);
    setSelectedType(null);
    onClose();
  };

  const selectedLabel = selectedType ? HAZARD_LABELS[selectedType].label : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={handleClose} />
        <View style={styles.sheet}>
          {/* Drag handle */}
          <View style={styles.handle} />

          {/* Header row: title + close */}
          <View style={styles.header}>
            <View style={styles.headerSpacer} />
            <Text style={styles.title}>Report a Hazard</Text>
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close hazard picker"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.closeIcon}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* 3-column grid */}
          <View style={styles.grid}>
            {types.map((type) => {
              const { label, emoji } = HAZARD_LABELS[type];
              return (
                <HazardCard
                  key={type}
                  type={type}
                  label={label}
                  emoji={emoji}
                  isSelected={selectedType === type}
                  size={cardSize}
                  onPress={() => setSelectedType(type === selectedType ? null : type)}
                />
              );
            })}
          </View>

          {/* Confirm button */}
          <TouchableOpacity
            style={[styles.confirmBtn, !selectedType && styles.confirmBtnDisabled]}
            onPress={handleConfirm}
            disabled={!selectedType}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={selectedLabel ? `Report ${selectedLabel}` : 'Select a hazard type'}
          >
            <Text style={styles.confirmText}>
              {selectedLabel ? `Report ${selectedLabel}` : 'Select a Hazard'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: '#0A0A0A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingTop: 8,
    paddingBottom: 36,
    paddingHorizontal: 20,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#444444',
    marginBottom: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  headerSpacer: {
    width: 32,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.3,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIcon: {
    fontSize: 14,
    color: '#888888',
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 20,
  },
  card: {
    borderRadius: 12,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
    padding: 8,
  },
  cardSelected: {
    backgroundColor: '#250008',
    borderColor: '#DC143C',
  },
  cardEmoji: {
    fontSize: 32,
    marginBottom: 6,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#888888',
    textAlign: 'center',
  },
  cardLabelSelected: {
    color: '#FFFFFF',
  },
  confirmBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnDisabled: {
    backgroundColor: '#3A0A14',
  },
  confirmText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.3,
  },
});

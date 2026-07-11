/**
 * HazardPicker — Hazard type selection sheet (Req 31.1–31.3)
 * Full 9-type grid when parked; max 6 large targets when in motion.
 * Select a type, then confirm with the full-width button.
 */

import React, { useMemo, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HAZARD_TYPES, HazardType } from '../services/HazardService';
import { ThemeColors, useTheme } from '../theme';

// ---------------------------------------------------------------------------
// Label / emoji mapping for display
// ---------------------------------------------------------------------------
// Hazard-type glyphs are deliberately kept as emoji rather than vector icons —
// they're used for instant visual recognition while driving (Req 31.1/31.2),
// and the same emoji set backs the corresponding pins on the map itself (see
// MapScreen's HAZARD_EMOJI), so keeping them in sync here matters more than
// converting to the icon system.

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
  styles: ReturnType<typeof makeStyles>;
}

function HazardCard({ label, emoji, isSelected, size, onPress, styles }: CardProps) {
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

function HazardPicker({ visible, isInMotion, onSelect, onClose }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
      statusBarTranslucent
      accessibilityViewIsModal
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={handleClose} accessible={false} />
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
              <Ionicons name="close" size={16} color={colors.textMuted} />
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
                  styles={styles}
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

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
      backgroundColor: colors.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      paddingTop: 8,
      paddingBottom: 36,
      paddingHorizontal: 20,
    },
    handle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.textSubtle,
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
      color: colors.text,
      letterSpacing: 0.3,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
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
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'transparent',
      padding: 8,
    },
    cardSelected: {
      backgroundColor: '#250008',
      borderColor: colors.accent,
    },
    cardEmoji: {
      fontSize: 32,
      marginBottom: 6,
    },
    cardLabel: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.textMuted,
      textAlign: 'center',
    },
    // cardSelected's background is a fixed dark maroon tint (not a themed surface),
    // so its label stays fixed white for contrast rather than colors.text.
    cardLabelSelected: {
      color: '#FFFFFF',
    },
    confirmBtn: {
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingVertical: 17,
      alignItems: 'center',
      justifyContent: 'center',
    },
    confirmBtnDisabled: {
      backgroundColor: '#3A0A14',
    },
    // confirmBtn's background is the fixed-value accent color (same in both
    // themes), so its label stays fixed white for contrast.
    confirmText: {
      fontSize: 17,
      fontWeight: '700',
      color: '#FFFFFF',
      letterSpacing: 0.3,
    },
  });
}

// Memoized: mounted permanently in MapScreen (usually with visible=false), which
// re-renders on every GPS tick; all props are stable callbacks/booleans there.
const MemoHazardPicker = React.memo(HazardPicker);
MemoHazardPicker.displayName = 'HazardPicker';
export default MemoHazardPicker;

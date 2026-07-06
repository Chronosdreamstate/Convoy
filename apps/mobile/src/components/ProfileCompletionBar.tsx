import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, useTheme } from '../theme';

interface Props {
  hasCallsign: boolean;
  hasVehicle: boolean;
  hasAvatar: boolean;
  hasFriend: boolean;
  onItemPress: (item: 'callsign' | 'vehicle' | 'avatar' | 'friend') => void;
}

const ITEMS: { key: 'callsign' | 'vehicle' | 'avatar' | 'friend'; label: string }[] = [
  { key: 'callsign', label: 'Callsign' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'avatar', label: 'Photo' },
  { key: 'friend', label: 'Friend' },
];

const BAR_WIDTH = 240;

export default function ProfileCompletionBar({ hasCallsign, hasVehicle, hasAvatar, hasFriend, onItemPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const completedCount = [hasCallsign, hasVehicle, hasAvatar, hasFriend].filter(Boolean).length;
  const pct = Math.round((completedCount / 4) * 100);
  const isComplete = pct === 100;

  const barAnim = useRef(new Animated.Value(0)).current;
  const [infoVisible, setInfoVisible] = useState(false);

  useEffect(() => {
    Animated.timing(barAnim, {
      toValue: (pct / 100) * BAR_WIDTH,
      duration: 600,
      useNativeDriver: false,
    }).start();
  }, [pct, barAnim]);

  const stateMap: Record<'callsign' | 'vehicle' | 'avatar' | 'friend', boolean> = {
    callsign: hasCallsign,
    vehicle: hasVehicle,
    avatar: hasAvatar,
    friend: hasFriend,
  };

  return (
    <View style={[styles.card, !isComplete && styles.cardIncomplete]}>
      {isComplete ? (
        <View style={styles.completeRow}>
          <Ionicons name="flag" size={16} color={colors.success} style={styles.completeIcon} />
          <Text style={styles.completeText}>Profile complete!</Text>
        </View>
      ) : (
        <>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Complete your profile</Text>
            <Text style={styles.pct}>{pct}%</Text>
          </View>

          <View style={styles.track}>
            <Animated.View style={[styles.fill, { width: barAnim }]} />
          </View>

          <View style={styles.chips}>
            {ITEMS.map(({ key, label }) => {
              const done = stateMap[key];
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.chip, done && styles.chipDone]}
                  onPress={() => !done && onItemPress(key)}
                  activeOpacity={done ? 1 : 0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${label} ${done ? 'complete' : 'incomplete'}`}
                >
                  <Ionicons
                    name={done ? 'checkmark-circle' : 'ellipse-outline'}
                    size={12}
                    color={done ? colors.success : colors.accent}
                    style={styles.chipIcon}
                  />
                  <Text style={[styles.chipLabel, done && styles.chipLabelDone]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {infoVisible ? (
            <Text style={styles.info}>
              Complete your profile to appear in group member lists and friend search results.
            </Text>
          ) : (
            <TouchableOpacity
              onPress={() => setInfoVisible(true)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Why complete your profile"
            >
              <Text style={styles.infoLink}>Why complete?</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      marginBottom: 16,
    },
    // A subtle accent-tinted border while incomplete draws the eye to this
    // card ahead of the (visually similar) settings rows below it — the
    // profile-completion nudge is the single most actionable item on this
    // screen for an incomplete profile, so it should read as such.
    cardIncomplete: {
      borderColor: colors.accent,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    title: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.text,
    },
    pct: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.accent,
    },
    track: {
      width: BAR_WIDTH,
      maxWidth: '100%',
      height: 6,
      backgroundColor: colors.border,
      borderRadius: 3,
      marginBottom: 14,
      overflow: 'hidden',
    },
    fill: {
      height: 6,
      backgroundColor: colors.accent,
      borderRadius: 3,
    },
    chips: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
      marginBottom: 10,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: 'transparent',
      minHeight: 28,
    },
    chipDone: {
      borderColor: colors.success,
    },
    chipIcon: {
      marginTop: -1,
    },
    chipLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.accent,
    },
    chipLabelDone: {
      color: colors.success,
    },
    info: {
      fontSize: 12,
      color: colors.textMuted,
      lineHeight: 16,
      marginTop: 4,
    },
    infoLink: {
      fontSize: 12,
      color: colors.textSubtle,
      textDecorationLine: 'underline',
    },
    completeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 4,
    },
    completeIcon: {
      marginRight: 6,
    },
    completeText: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.success,
      textAlign: 'center',
    },
  });
}

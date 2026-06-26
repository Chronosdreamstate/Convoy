import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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
  }, [pct]);

  const stateMap: Record<'callsign' | 'vehicle' | 'avatar' | 'friend', boolean> = {
    callsign: hasCallsign,
    vehicle: hasVehicle,
    avatar: hasAvatar,
    friend: hasFriend,
  };

  return (
    <View style={styles.card}>
      {isComplete ? (
        <Text style={styles.completeText}>🏁 Profile complete!</Text>
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
                  accessibilityLabel={`${label} ${done ? 'complete' : 'incomplete'}`}
                >
                  <Text style={[styles.chipIcon, done && styles.chipIconDone]}>
                    {done ? '✓' : '○'}
                  </Text>
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
            <TouchableOpacity onPress={() => setInfoVisible(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.infoLink}>Why complete?</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 16,
    marginBottom: 16,
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
    color: '#FFFFFF',
  },
  pct: {
    fontSize: 14,
    fontWeight: '700',
    color: '#DC143C',
  },
  track: {
    width: BAR_WIDTH,
    height: 6,
    backgroundColor: '#2A2A2A',
    borderRadius: 3,
    marginBottom: 14,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    backgroundColor: '#DC143C',
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
    borderColor: '#DC143C',
    backgroundColor: 'transparent',
  },
  chipDone: {
    borderColor: '#22C55E',
  },
  chipIcon: {
    fontSize: 11,
    color: '#DC143C',
    fontWeight: '700',
  },
  chipIconDone: {
    color: '#22C55E',
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#DC143C',
  },
  chipLabelDone: {
    color: '#22C55E',
  },
  info: {
    fontSize: 12,
    color: '#888888',
    lineHeight: 16,
    marginTop: 4,
  },
  infoLink: {
    fontSize: 12,
    color: '#555555',
    textDecorationLine: 'underline',
  },
  completeText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#22C55E',
    textAlign: 'center',
    paddingVertical: 4,
  },
});

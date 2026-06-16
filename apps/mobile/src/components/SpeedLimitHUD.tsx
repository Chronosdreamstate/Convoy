/**
 * Speed limit HUD overlay (Req 23.1–23.4)
 * Displays posted speed limit; highlights when current speed exceeds it.
 */
import React from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { RouteService } from '../services/RouteService';

interface Props {
  /** Posted speed limit in km/h. null means data unavailable. */
  postedLimitKph: number | null;
  /** Current GPS speed in km/h. */
  currentSpeedKph: number;
}

export default function SpeedLimitHUD({ postedLimitKph, currentSpeedKph }: Props) {
  const exceeded =
    postedLimitKph !== null &&
    RouteService.isSpeedLimitExceeded(currentSpeedKph, postedLimitKph);

  return (
    <View style={[styles.container, exceeded && styles.exceeded]}>
      <Text style={styles.label}>SPEED LIMIT</Text>
      <Text style={[styles.value, exceeded && styles.valueExceeded]}>
        {postedLimitKph !== null ? postedLimitKph : '–'}
      </Text>
      <Text style={styles.unit}>km/h</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ffffff',
    borderWidth: 3,
    borderColor: '#d1d5db',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  exceeded: {
    borderColor: '#ef4444',
    backgroundColor: '#fef2f2',
  },
  label: {
    fontSize: 6,
    fontWeight: '700',
    color: '#6b7280',
    letterSpacing: 0.5,
  },
  value: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111827',
    lineHeight: 22,
  },
  valueExceeded: {
    color: '#ef4444',
  },
  unit: {
    fontSize: 7,
    fontWeight: '600',
    color: '#9ca3af',
  },
});

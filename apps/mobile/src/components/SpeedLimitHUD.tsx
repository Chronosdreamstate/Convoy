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
      <Text style={styles.label} maxFontSizeMultiplier={1}>SPEED LIMIT</Text>
      <Text style={[styles.value, exceeded && styles.valueExceeded]} maxFontSizeMultiplier={1.2}>
        {postedLimitKph !== null ? postedLimitKph : '–'}
      </Text>
      <Text style={styles.unit} maxFontSizeMultiplier={1}>km/h</Text>
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
    borderColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  exceeded: {
    borderColor: '#DC143C',
    backgroundColor: '#fff0f0',
  },
  label: {
    fontSize: 6,
    fontWeight: '700',
    color: '#555555',
    letterSpacing: 0.5,
  },
  value: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0A0A0A',
    lineHeight: 22,
  },
  valueExceeded: {
    color: '#DC143C',
  },
  unit: {
    fontSize: 7,
    fontWeight: '600',
    color: '#888888',
  },
});

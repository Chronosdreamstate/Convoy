/**
 * Speed limit HUD overlay (Req 23.1–23.4)
 * Displays posted speed limit sign + current speed; animates when significantly over limit.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, Text } from 'react-native';
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

  // Pulse when ≥10% over limit (belt-and-braces alert beyond the color change)
  const significantlyOver =
    postedLimitKph !== null && currentSpeedKph > postedLimitKph * 1.1;

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (significantlyOver) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.08,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
      return undefined;
    }
  }, [significantlyOver, pulseAnim]);

  const speedLabel = Math.round(currentSpeedKph);

  const a11yLabel =
    postedLimitKph !== null
      ? `Speed limit ${postedLimitKph} km/h. Current speed ${speedLabel} km/h${exceeded ? ', exceeded' : ''}`
      : `Speed limit unavailable. Current speed ${speedLabel} km/h`;

  return (
    <View style={styles.wrapper} accessibilityLabel={a11yLabel} accessibilityRole="text">
      {/* Current speed readout */}
      <View style={styles.currentSpeedRow}>
        <Text
          style={[styles.currentSpeed, exceeded && styles.currentSpeedOver]}
          maxFontSizeMultiplier={1}
        >
          {speedLabel}
        </Text>
        <Text
          style={[styles.currentSpeedUnit, exceeded && styles.currentSpeedOver]}
          maxFontSizeMultiplier={1}
        >
          km/h
        </Text>
      </View>

      {/* Road sign */}
      <Animated.View style={[styles.sign, { transform: [{ scale: pulseAnim }] }]}>
        <Text style={styles.signLimit} maxFontSizeMultiplier={1}>
          {postedLimitKph !== null ? String(postedLimitKph) : '–'}
        </Text>
        <Text style={styles.signUnit} maxFontSizeMultiplier={1}>
          {postedLimitKph !== null ? 'KMH' : 'No data'}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  currentSpeedRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 4,
  },
  currentSpeed: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: 22,
  },
  currentSpeedUnit: {
    fontSize: 10,
    fontWeight: '600',
    color: '#AAAAAA',
    marginLeft: 2,
    marginBottom: 1,
  },
  currentSpeedOver: {
    color: '#DC143C',
  },
  sign: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 6,
  },
  signLimit: {
    fontSize: 24,
    fontWeight: '900',
    color: '#000000',
    lineHeight: 26,
    letterSpacing: -0.5,
  },
  signUnit: {
    fontSize: 9,
    fontWeight: '700',
    color: '#333333',
    letterSpacing: 0.5,
    marginTop: -2,
  },
});

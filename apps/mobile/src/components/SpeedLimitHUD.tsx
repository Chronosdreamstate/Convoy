/**
 * Speed limit HUD overlay (Req 23.1–23.4)
 * Displays posted speed limit sign + current speed; animates when significantly over limit.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  TouchableOpacity,
  View,
  Text,
} from 'react-native';

const MPH_TO_KMH = 1.60934;
const AUTO_HIDE_DELAY_MS = 5_000;

interface Props {
  /** Posted speed limit in km/h. null means data unavailable. */
  postedLimitKph?: number | null;
  /** Current GPS speed in km/h. */
  currentSpeedKph?: number;
  /** Current user speed in mph (takes precedence over currentSpeedKph). */
  userSpeedMph?: number;
  /** Posted speed limit in mph (takes precedence over postedLimitKph; defaults to 65). */
  speedLimitMph?: number;
}

function SpeedLimitHUD({
  postedLimitKph,
  currentSpeedKph = 0,
  userSpeedMph,
  speedLimitMph,
}: Props) {
  // ── Resolve canonical mph values ──────────────────────────────────────────
  const resolvedSpeedMph: number =
    userSpeedMph !== undefined ? userSpeedMph : currentSpeedKph / MPH_TO_KMH;

  /** True only when an explicit limit was provided (not just the 65 mph default). */
  const hasExplicitLimit =
    speedLimitMph !== undefined || postedLimitKph != null;

  const resolvedLimitMph: number =
    speedLimitMph !== undefined
      ? speedLimitMph
      : postedLimitKph != null
        ? postedLimitKph / MPH_TO_KMH
        : 65;

  // ── Unit toggle (mph ↔ km/h) ──────────────────────────────────────────────
  const [unit, setUnit] = useState<'mph' | 'kmh'>('mph');
  const toggleUnit = () => setUnit(u => (u === 'mph' ? 'kmh' : 'mph'));

  const displaySpeed =
    unit === 'mph'
      ? Math.round(resolvedSpeedMph)
      : Math.round(resolvedSpeedMph * MPH_TO_KMH);

  const displayLimit =
    unit === 'mph'
      ? Math.round(resolvedLimitMph)
      : Math.round(resolvedLimitMph * MPH_TO_KMH);

  const unitLabel = unit === 'mph' ? 'mph' : 'km/h';

  // ── Over-limit detection ──────────────────────────────────────────────────
  const exceeded = resolvedSpeedMph > resolvedLimitMph;
  const significantlyOver = resolvedSpeedMph > resolvedLimitMph * 1.1;

  // ── Border opacity pulse (1.0 ↔ 0.7, 600 ms) when significantly over ─────
  const borderOpacityAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (significantlyOver) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(borderOpacityAnim, {
            toValue: 0.7,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(borderOpacityAnim, {
            toValue: 1.0,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    }
    borderOpacityAnim.setValue(1);
    return undefined;
  }, [significantlyOver, borderOpacityAnim]);

  // ── Auto-hide when stationary for > AUTO_HIDE_DELAY_MS ───────────────────
  const [visible, setVisible] = useState(true);
  const hudOpacityAnim = useRef(new Animated.Value(1)).current;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const isMoving = resolvedSpeedMph > 0;

    if (isMoving) {
      // Cancel any pending hide timer
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      // Re-show if currently hidden
      if (!visibleRef.current) {
        visibleRef.current = true;
        setVisible(true);
        Animated.timing(hudOpacityAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      }
    } else if (!hideTimerRef.current && visibleRef.current) {
      // Speed is 0 — begin countdown once; don't reset on each re-render
      hideTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        Animated.timing(hudOpacityAnim, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }).start(() => {
          if (!cancelled) {
            visibleRef.current = false;
            setVisible(false);
          }
        });
        hideTimerRef.current = null;
      }, AUTO_HIDE_DELAY_MS);
    }

    return () => {
      cancelled = true;
    };
  }, [resolvedSpeedMph, hudOpacityAnim]);

  // ── Accessibility ─────────────────────────────────────────────────────────
  const a11yLabel = hasExplicitLimit
    ? `Speed limit ${displayLimit} ${unitLabel}. Current speed ${displaySpeed} ${unitLabel}${exceeded ? ', exceeded' : ''}`
    : `Speed limit unavailable. Current speed ${displaySpeed} ${unitLabel}`;

  // ── Dynamic sign border color ─────────────────────────────────────────────
  const borderColor = significantlyOver ? '#DC143C' : '#2A2A2A';

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.wrapper, { opacity: hudOpacityAnim }]}
      accessibilityLabel={a11yLabel}
      accessibilityRole="text"
    >
      {/* Current speed readout */}
      <View style={styles.currentSpeedRow}>
        <Text
          style={[styles.currentSpeed, exceeded && styles.currentSpeedOver]}
          maxFontSizeMultiplier={1}
        >
          {displaySpeed}
        </Text>
      </View>

      {/* Unit toggle — tap to switch mph ↔ km/h */}
      <TouchableOpacity
        onPress={toggleUnit}
        style={styles.unitToggle}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel={`Speed in ${unitLabel}. Tap to switch units.`}
      >
        <Text style={styles.unitToggleText}>{unitLabel}</Text>
      </TouchableOpacity>

      {/* Road sign */}
      <Animated.View
        style={[styles.sign, { borderColor, opacity: borderOpacityAnim }]}
      >
        <Text style={styles.signLimit} maxFontSizeMultiplier={1}>
          {hasExplicitLimit ? String(displayLimit) : '–'}
        </Text>
        <Text style={styles.signUnit} maxFontSizeMultiplier={1}>
          {hasExplicitLimit ? unitLabel.toUpperCase() : 'No data'}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const MemoSpeedLimitHUD = React.memo(SpeedLimitHUD);
MemoSpeedLimitHUD.displayName = 'SpeedLimitHUD';
export default MemoSpeedLimitHUD;

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  currentSpeedRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 2,
  },
  currentSpeed: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: 22,
  },
  currentSpeedOver: {
    color: '#DC143C',
  },
  unitToggle: {
    marginBottom: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: '#1C1C1C',
  },
  unitToggleText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#888888',
    letterSpacing: 0.3,
  },
  sign: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: '#2A2A2A',
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

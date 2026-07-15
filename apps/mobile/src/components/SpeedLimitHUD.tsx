/**
 * Speed limit HUD overlay (Req 23.1–23.4)
 * Displays posted speed limit sign + current speed; animates when significantly over limit.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  TouchableOpacity,
  View,
  Text,
} from 'react-native';
import { ThemeColors, useTheme } from '../theme';
import { useReduceMotion } from '../hooks/useReduceMotion';

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
  /** App-wide distance unit preference (Req 16 settings, Req 23.4) — 'mph' or 'kmh'. */
  preferredUnit?: 'mph' | 'kmh';
}

function SpeedLimitHUD({
  postedLimitKph,
  currentSpeedKph = 0,
  userSpeedMph,
  speedLimitMph,
  preferredUnit,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

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
  // Defaults to (and re-syncs with) the app-wide distance-unit preference
  // (Req 23.4), but a manual tap can still override it for the current view.
  const [unit, setUnit] = useState<'mph' | 'kmh'>(preferredUnit ?? 'mph');
  const toggleUnit = () => setUnit(u => (u === 'mph' ? 'kmh' : 'mph'));

  useEffect(() => {
    if (preferredUnit) setUnit(preferredUnit);
  }, [preferredUnit]);

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
  // Gated on hasExplicitLimit: with no posted-limit data the sign shows "–"
  // (Req 23.4) and resolvedLimitMph is only the 65 mph placeholder — flashing
  // the red over-limit treatment against a limit we invented would be a false
  // alarm (Req 23.3 highlights exceeding the POSTED limit).
  const exceeded = hasExplicitLimit && resolvedSpeedMph > resolvedLimitMph;
  const significantlyOver = hasExplicitLimit && resolvedSpeedMph > resolvedLimitMph * 1.1;

  // ── Border opacity pulse (1.0 ↔ 0.7, 600 ms) when significantly over ─────
  // Held static under OS reduce-motion — the over-limit warning is still
  // conveyed by the border color change itself.
  const borderOpacityAnim = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (significantlyOver && !reduceMotion) {
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
  }, [significantlyOver, borderOpacityAnim, reduceMotion]);

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
  const borderColor = significantlyOver ? colors.accent : colors.border;

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

      {/* Road sign — always rendered in real-world sign colors (white face, black
          text) regardless of app theme, since it represents an actual roadside
          speed-limit sign rather than themed app chrome. */}
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

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
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
      color: colors.text,
      lineHeight: 22,
    },
    currentSpeedOver: {
      color: colors.accent,
    },
    unitToggle: {
      marginBottom: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: colors.card,
    },
    unitToggleText: {
      fontSize: 10,
      fontWeight: '600',
      color: colors.textMuted,
      letterSpacing: 0.3,
    },
    sign: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: '#FFFFFF',
      borderWidth: 4,
      borderColor: colors.border,
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
}

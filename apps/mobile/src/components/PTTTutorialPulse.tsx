import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, withAlpha } from '../theme';
import { useReduceMotion } from '../hooks/useReduceMotion';

// Icon always sits on the crimson accent fill — stays light in both themes.
const ON_ACCENT = '#FFFFFF';

const BUTTON_SIZE = 80;

/**
 * PTTTutorialPulse — the mock PTT button with a looping pulse ring used in the
 * onboarding tutorial. Purely presentational (non-functional demo).
 *
 * Respects the OS reduce-motion setting (Req 39–41): when reduce motion is on,
 * the looping scale/opacity pulse is replaced by a static halo ring so the
 * affordance stays visible without animation.
 */
function PTTTutorialPulse() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const reduceMotion = useReduceMotion();

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) return;

    scaleAnim.setValue(1);
    opacityAnim.setValue(1);
    const pulse = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scaleAnim, { toValue: 1.3, duration: 1200, useNativeDriver: true }),
          Animated.timing(scaleAnim, { toValue: 1, duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacityAnim, { toValue: 0, duration: 1200, useNativeDriver: true }),
          Animated.timing(opacityAnim, { toValue: 1, duration: 0, useNativeDriver: true }),
        ]),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [reduceMotion, scaleAnim, opacityAnim]);

  return (
    <View style={styles.buttonWrapper}>
      {reduceMotion ? (
        // Static affordance — a resting halo ring, no looping motion.
        <View style={[styles.pulseRing, styles.staticRing]} testID="ptt-tutorial-ring-static" />
      ) : (
        <Animated.View
          testID="ptt-tutorial-ring-animated"
          style={[
            styles.pulseRing,
            { transform: [{ scale: scaleAnim }], opacity: opacityAnim },
          ]}
        />
      )}

      {/* Mock PTT button — non-functional UI demo */}
      <View style={styles.pttButton}>
        <Ionicons name="mic" size={36} color={ON_ACCENT} />
      </View>
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    buttonWrapper: {
      width: 160,
      height: 160,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pulseRing: {
      position: 'absolute',
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: BUTTON_SIZE / 2,
      borderWidth: 3,
      borderColor: theme.colors.accent,
    },
    // Reduce-motion variant: slightly expanded, softened halo held statically.
    staticRing: {
      width: BUTTON_SIZE + 20,
      height: BUTTON_SIZE + 20,
      borderRadius: (BUTTON_SIZE + 20) / 2,
      borderColor: withAlpha(theme.colors.accent, 0.55),
    },
    pttButton: {
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: BUTTON_SIZE / 2,
      backgroundColor: theme.colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}

export default React.memo(PTTTutorialPulse);

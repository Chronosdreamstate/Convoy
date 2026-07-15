import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { ThemeColors, useTheme, withAlpha } from '../theme';
import { useReduceMotion } from '../hooks/useReduceMotion';

const STORAGE_KEY = 'coach_marks_shown';

interface Hint {
  step: string;
  icon: string;
  title: string;
  body: string;
  spotlightStyle: object;
  tooltipStyle: object;
}

const HINTS: Hint[] = [
  {
    step: '1 of 3',
    icon: '🎙️',
    title: 'Hold to talk',
    body: 'Press and hold to transmit to your convoy',
    spotlightStyle: { bottom: 140, alignSelf: 'center' as const },
    tooltipStyle: { bottom: 280, alignSelf: 'center' as const },
  },
  {
    step: '2 of 3',
    icon: '👥',
    title: 'Member list',
    body: 'Tap to see who\'s in your convoy',
    spotlightStyle: { bottom: 140, right: 20 },
    tooltipStyle: { bottom: 280, right: 16 },
  },
  {
    step: '3 of 3',
    icon: '⚠️',
    title: 'Report hazard',
    body: 'Tap to warn the group about road hazards',
    spotlightStyle: { top: 120, right: 20 },
    tooltipStyle: { top: 260, right: 16 },
  },
];

interface Props {
  visible: boolean;
  onComplete: () => void;
}

function CoachMarkOverlay({ visible, onComplete }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (visible) {
      setStep(0);
      // Reduce-motion: show instantly instead of fading in.
      if (reduceMotion) { fadeAnim.setValue(1); return; }
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, reduceMotion]);

  function fadeToNext(nextStep: number) {
    // Reduce-motion: jump straight to the next step without the cross-fade.
    if (reduceMotion) { setStep(nextStep); fadeAnim.setValue(1); return; }
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(() => {
      setStep(nextStep);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    });
  }

  async function persistAndComplete() {
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, '1');
    } catch {
      // intentionally empty — persisting the "seen" flag is best-effort only
    }
    onComplete();
  }

  async function finishCoachMarks() {
    // Reduce-motion: skip the fade-out but still persist + complete.
    if (reduceMotion) { await persistAndComplete(); return; }
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start(() => { void persistAndComplete(); });
  }

  async function handleGotIt() {
    if (step < HINTS.length - 1) {
      fadeToNext(step + 1);
    } else {
      await finishCoachMarks();
    }
  }

  async function handleSkip() {
    await finishCoachMarks();
  }

  if (!visible) return null;

  const hint = HINTS[step];
  const isLastStep = step === HINTS.length - 1;

  return (
    <Modal
      transparent
      animationType="none"
      visible={visible}
      statusBarTranslucent
      onRequestClose={() => { void finishCoachMarks(); }}
    >
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
        {/* Skip — always visible, so the tour never traps the user into
            tapping through all 3 steps. */}
        <TouchableOpacity
          style={styles.skipButton}
          onPress={() => { void handleSkip(); }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Skip tips"
          accessibilityHint="Dismisses the walkthrough immediately"
        >
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>

        {/* Spotlight indicator */}
        <View style={[styles.spotlight, hint.spotlightStyle]}>
          <View style={styles.spotlightInner} />
        </View>

        {/* Tooltip card */}
        <View style={[styles.tooltip, hint.tooltipStyle]}>
          <Text style={styles.stepLabel}>{hint.step}</Text>
          <Text style={styles.tooltipIcon}>{hint.icon}</Text>
          <Text style={styles.tooltipTitle}>{hint.title}</Text>
          <Text style={styles.tooltipBody}>{hint.body}</Text>
          <TouchableOpacity
            style={styles.gotItButton}
            onPress={() => { void handleGotIt(); }}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={isLastStep ? 'Got it, finish walkthrough' : 'Got it, next tip'}
          >
            <Text style={styles.gotItText}>{isLastStep ? 'Got it' : 'Got it, next'}</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.78)',
    },
    // The scrim behind this button is a fixed dark overlay (not theme-driven —
    // see `overlay` below), so the button treatment is fixed white-on-black
    // too rather than derived from `colors`, which would go near-invisible
    // in light mode (dark text-color tint on a dark scrim).
    skipButton: {
      position: 'absolute',
      top: 56,
      right: 20,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 100,
      backgroundColor: 'rgba(255,255,255,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.28)',
    },
    // Sits on the modal's fixed dark scrim (rgba(0,0,0,0.78), same in both
    // themes), so a fixed white label always has contrast.
    skipButtonText: {
      color: '#FFFFFF',
      fontSize: 13,
      fontWeight: '700',
    },
    spotlight: {
      position: 'absolute',
      width: 128,
      height: 128,
      borderRadius: 64,
      borderWidth: 2,
      borderColor: colors.accent,
      justifyContent: 'center',
      alignItems: 'center',
    },
    spotlightInner: {
      width: 112,
      height: 112,
      borderRadius: 56,
      backgroundColor: withAlpha(colors.accent, 0.12),
    },
    tooltip: {
      position: 'absolute',
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      maxWidth: 280,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.5,
      shadowRadius: 16,
      elevation: 12,
    },
    stepLabel: {
      color: colors.textMuted,
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginBottom: 8,
    },
    tooltipIcon: {
      fontSize: 28,
      marginBottom: 8,
    },
    tooltipTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '700',
      marginBottom: 6,
    },
    tooltipBody: {
      color: colors.textMuted,
      fontSize: 14,
      lineHeight: 20,
      marginBottom: 16,
    },
    gotItButton: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
      minHeight: 44,
      justifyContent: 'center',
    },
    // Fixed-value accent button (same in both themes) — label stays fixed white.
    gotItText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '700',
    },
  });
}

// Memoized: mounted permanently in MapScreen (visible=false after the first-run
// tour), which re-renders on every GPS tick; both props are stable there.
const MemoCoachMarkOverlay = React.memo(CoachMarkOverlay);
MemoCoachMarkOverlay.displayName = 'CoachMarkOverlay';
export default MemoCoachMarkOverlay;

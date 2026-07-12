import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HapticService } from '../services/HapticService';
import { ThemeColors, useTheme, withAlpha } from '../theme';
import { useReduceMotion } from '../hooks/useReduceMotion';

export const PTT_BUTTON_SIZE = 80;

interface Props {
  onHoldStart: () => void;
  onHoldEnd: () => void;
  isTransmitting: boolean;
  isMuted?: boolean;
  disabled?: boolean;
  size?: number;
}

// Waveform bar heights — 5 bars oscillate at staggered speeds during transmission
const WAVEFORM_BARS = 5;
const BAR_DURATIONS = [220, 300, 180, 260, 200];

function PTTButton({
  onHoldStart,
  onHoldEnd,
  isTransmitting,
  isMuted = false,
  disabled = false,
  size = PTT_BUTTON_SIZE,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const scale = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(1)).current;
  const shadowAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef<Animated.CompositeAnimation | null>(null);
  const glowLoop = useRef<Animated.CompositeAnimation | null>(null);
  const waveAnims = useRef(
    Array.from({ length: WAVEFORM_BARS }, () => new Animated.Value(0.2))
  ).current;
  const waveLoop = useRef<Animated.CompositeAnimation | null>(null);

  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (isTransmitting && !disabled && !isMuted && reduceMotion) {
      // OS reduce-motion: static transmit feedback instead of the looping
      // ring/glow/waveform — steady ring at rest, raised glow, mid-height bars.
      pulseAnim.current?.stop();
      glowLoop.current?.stop();
      waveLoop.current?.stop();
      ringOpacity.setValue(0.5);
      ringScale.setValue(1.25);
      shadowAnim.setValue(1);
      waveAnims.forEach(a => a.setValue(0.6));
      return;
    }
    if (isTransmitting && !disabled && !isMuted) {
      pulseAnim.current = Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(ringOpacity, { toValue: 0.7, duration: 200, useNativeDriver: true }),
            Animated.timing(ringScale, { toValue: 1.0, duration: 200, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(ringOpacity, { toValue: 0, duration: 700, useNativeDriver: true }),
            Animated.timing(ringScale, { toValue: 1.7, duration: 700, useNativeDriver: true }),
          ]),
          Animated.timing(ringScale, { toValue: 1.0, duration: 0, useNativeDriver: true }),
        ]),
      );
      pulseAnim.current.start();

      glowLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(shadowAnim, { toValue: 1, duration: 600, useNativeDriver: false }),
          Animated.timing(shadowAnim, { toValue: 0.4, duration: 600, useNativeDriver: false }),
        ]),
      );
      glowLoop.current.start();

      // Waveform bars — each bar oscillates at a different speed
      waveLoop.current = Animated.loop(
        Animated.parallel(
          waveAnims.map((anim, i) =>
            Animated.sequence([
              Animated.timing(anim, { toValue: 1, duration: BAR_DURATIONS[i], useNativeDriver: false }),
              Animated.timing(anim, { toValue: 0.2, duration: BAR_DURATIONS[i], useNativeDriver: false }),
            ])
          )
        )
      );
      waveLoop.current.start();
    } else {
      pulseAnim.current?.stop();
      glowLoop.current?.stop();
      waveLoop.current?.stop();
      waveAnims.forEach(a => Animated.timing(a, { toValue: 0.2, duration: 150, useNativeDriver: false }).start());
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.timing(ringOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(shadowAnim, { toValue: 0, duration: 200, useNativeDriver: false }),
      ]).start();
    }
    return () => {
      pulseAnim.current?.stop();
      glowLoop.current?.stop();
      waveLoop.current?.stop();
    };
  }, [isTransmitting, disabled, isMuted, reduceMotion]);

  const handlePressIn = () => {
    if (disabled || isMuted) return;
    Animated.spring(scale, { toValue: 0.92, useNativeDriver: true }).start();
    HapticService.pttStart();
    onHoldStart();
  };

  const handlePressOut = () => {
    if (disabled || isMuted) return;
    if (!isTransmitting) {
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
    }
    HapticService.pttEnd();
    onHoldEnd();
  };

  const bgColor = disabled
    ? colors.border
    : isMuted
    ? withAlpha(colors.error, 0.28)
    : colors.accent;

  const elevation = shadowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 28],
  });

  const iconName = isMuted ? 'mic-off' : 'mic';

  const labelText = isMuted
    ? 'MUTED'
    : isTransmitting
    ? 'TRANSMITTING'
    : disabled
    ? 'UNAVAILABLE'
    : 'HOLD TO TALK';

  const labelColor = isMuted || disabled
    ? colors.textSubtle
    : isTransmitting
    ? colors.accent
    : colors.textMuted;

  return (
    <View style={styles.wrapper}>
      {/* Expanding ring pulse */}
      <Animated.View
        style={[
          styles.ring,
          {
            width: size * 1.7,
            height: size * 1.7,
            borderRadius: (size * 1.7) / 2,
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          },
        ]}
        pointerEvents="none"
      />

      <Pressable
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled}
        // Large hitSlop on top of an already-80pt button — this control is used
        // one-handed while driving, so the effective touch target needs to be
        // as forgiving as possible.
        hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
        accessibilityRole="button"
        accessibilityLabel={
          isTransmitting
            ? 'Stop transmitting. Currently broadcasting to convoy.'
            : isMuted
            ? 'Push to talk muted. Tap to unmute.'
            : 'Push to talk. Hold to transmit voice to convoy.'
        }
        accessibilityHint="Double tap and hold to transmit voice"
        accessibilityState={{ selected: isTransmitting, disabled: disabled || isMuted }}
      >
        <Animated.View
          style={[
            styles.button,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: bgColor,
              opacity: disabled ? 0.4 : 1,
              transform: [{ scale }],
              elevation,
            },
            isTransmitting && styles.buttonTransmitting,
          ]}
        >
          <Ionicons
            name={iconName}
            size={isTransmitting ? size * 0.3 : size * 0.4}
            color="#FFFFFF"
            style={styles.mic}
          />
          {isTransmitting && (
            <View style={styles.waveform}>
              {waveAnims.map((anim, i) => (
                <Animated.View
                  key={i}
                  style={[
                    styles.waveBar,
                    {
                      height: anim.interpolate({
                        inputRange: [0.2, 1],
                        outputRange: [4, 16],
                      }),
                    },
                  ]}
                />
              ))}
            </View>
          )}
        </Animated.View>
      </Pressable>

      <Text style={[styles.label, { color: labelColor }]}>{labelText}</Text>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrapper: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    ring: {
      position: 'absolute',
      alignSelf: 'center',
      backgroundColor: withAlpha(colors.accent, 0.22),
      borderWidth: 1.5,
      borderColor: withAlpha(colors.accent, 0.35),
    },
    button: {
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.6,
      shadowRadius: 14,
    },
    // Border overlay only ever sits on top of the button's own accent-colored
    // fill (never the screen background), so a fixed white ring reads
    // correctly in both themes without needing a dedicated token.
    buttonTransmitting: {
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.25)',
    },
    mic: {},
    waveform: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 3,
      height: 18,
      marginTop: 4,
    },
    // Same reasoning as buttonTransmitting — bars render on the accent fill.
    waveBar: {
      width: 3,
      borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.9)',
    },
    label: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1.8,
    },
  });
}

export default React.memo(PTTButton);

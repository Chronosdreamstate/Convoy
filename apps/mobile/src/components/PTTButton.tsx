import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

export const PTT_BUTTON_SIZE = 80;

interface Props {
  onHoldStart: () => void;
  onHoldEnd: () => void;
  isTransmitting: boolean;
  isMuted?: boolean;
  disabled?: boolean;
  size?: number;
}

function PTTButton({
  onHoldStart,
  onHoldEnd,
  isTransmitting,
  isMuted = false,
  disabled = false,
  size = PTT_BUTTON_SIZE,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(1)).current;
  const shadowAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef<Animated.CompositeAnimation | null>(null);
  const glowLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
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
    } else {
      pulseAnim.current?.stop();
      glowLoop.current?.stop();
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.timing(ringOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(shadowAnim, { toValue: 0, duration: 200, useNativeDriver: false }),
      ]).start();
    }
    return () => {
      pulseAnim.current?.stop();
      glowLoop.current?.stop();
    };
  }, [isTransmitting, disabled, isMuted]);

  const handlePressIn = () => {
    if (disabled || isMuted) return;
    Animated.spring(scale, { toValue: 0.92, useNativeDriver: true }).start();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Haptics = require('expo-haptics');
      void Haptics.impactAsync('medium');
    } catch { /* non-fatal */ }
    onHoldStart();
  };

  const handlePressOut = () => {
    if (disabled || isMuted) return;
    if (!isTransmitting) {
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
    }
    onHoldEnd();
  };

  const bgColor = disabled
    ? '#2A2A2A'
    : isMuted
    ? '#3A2A2A'
    : isTransmitting
    ? '#FF1744'
    : '#DC143C';

  const elevation = shadowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 28],
  });

  const icon = isMuted ? '🔇' : '🎙️';

  const labelText = isMuted
    ? 'MUTED'
    : isTransmitting
    ? 'TRANSMITTING'
    : disabled
    ? 'UNAVAILABLE'
    : 'HOLD TO TALK';

  const labelColor = isMuted
    ? '#555555'
    : isTransmitting
    ? '#FF1744'
    : disabled
    ? '#444444'
    : '#888888';

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
        accessibilityRole="button"
        accessibilityLabel="Push to talk"
        accessibilityHint={isMuted ? 'Microphone is muted' : 'Hold to transmit, release to stop'}
        accessibilityState={{ disabled: disabled || isMuted }}
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
          <Text style={[styles.mic, { fontSize: size * 0.4 }]}>{icon}</Text>
        </Animated.View>
      </Pressable>

      <Text style={[styles.label, { color: labelColor }]}>{labelText}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  ring: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(220,20,60,0.22)',
    borderWidth: 1.5,
    borderColor: 'rgba(220,20,60,0.35)',
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#DC143C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.6,
    shadowRadius: 14,
  },
  buttonTransmitting: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  mic: {
    lineHeight: undefined,
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.8,
  },
});

export default React.memo(PTTButton);

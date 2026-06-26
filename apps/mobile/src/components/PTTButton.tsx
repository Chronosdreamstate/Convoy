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

function PTTButton({ onHoldStart, onHoldEnd, isTransmitting, disabled = false, size = PTT_BUTTON_SIZE }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(0.8)).current;
  const pulseAnim = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (isTransmitting && !disabled) {
      pulseAnim.current = Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(scale, { toValue: 1.1, duration: 300, useNativeDriver: true }),
            Animated.timing(scale, { toValue: 1.0, duration: 300, useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(ringOpacity, { toValue: 0.6, duration: 200, useNativeDriver: true }),
            Animated.timing(ringOpacity, { toValue: 0, duration: 600, useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(ringScale, { toValue: 1.5, duration: 800, useNativeDriver: true }),
            Animated.timing(ringScale, { toValue: 0.8, duration: 0, useNativeDriver: true }),
          ]),
        ]),
      );
      pulseAnim.current.start();
    } else {
      pulseAnim.current?.stop();
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.timing(ringOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    return () => { pulseAnim.current?.stop(); };
  }, [isTransmitting, disabled]);

  const handlePressIn = () => {
    if (disabled) return;
    Animated.spring(scale, { toValue: 0.94, useNativeDriver: true }).start();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Haptics = require('expo-haptics');
      void Haptics.impactAsync('medium');
    } catch { /* non-fatal */ }
    onHoldStart();
  };

  const handlePressOut = () => {
    if (disabled) return;
    if (!isTransmitting) {
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
    }
    onHoldEnd();
  };

  const bgColor = disabled ? '#2A2A2A' : isTransmitting ? '#FF1744' : '#DC143C';

  return (
    <View style={styles.wrapper}>
      {/* Pulsing outer ring */}
      <Animated.View
        style={[
          styles.ring,
          {
            width: size * 1.6,
            height: size * 1.6,
            borderRadius: size * 0.8,
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          },
        ]}
      />

      <Pressable
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Push to talk"
        accessibilityHint="Hold to transmit, release to stop"
        accessibilityState={{ disabled }}
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
            },
          ]}
        >
          <Text style={styles.mic}>🎙️</Text>
        </Animated.View>
      </Pressable>

      <Text style={[styles.label, isTransmitting && styles.labelActive]}>
        {isTransmitting ? 'TRANSMITTING' : disabled ? 'UNAVAILABLE' : 'HOLD'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    gap: 6,
  },
  ring: {
    position: 'absolute',
    backgroundColor: '#DC143C33',
    alignSelf: 'center',
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#DC143C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
  mic: {
    fontSize: 32,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: '#888888',
  },
  labelActive: {
    color: '#DC143C',
  },
});

export default React.memo(PTTButton);

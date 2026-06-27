import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

interface SplashScreenProps {
  onReady: () => void;
}

export default function SplashScreen({ onReady }: SplashScreenProps) {
  const carScale = useRef(new Animated.Value(1.0)).current;
  const dot1Opacity = useRef(new Animated.Value(0.3)).current;
  const dot2Opacity = useRef(new Animated.Value(0.3)).current;
  const dot3Opacity = useRef(new Animated.Value(0.3)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Car pulse: scale 1.0 → 1.15 → 1.0, 1.2s period
    Animated.loop(
      Animated.sequence([
        Animated.timing(carScale, { toValue: 1.15, duration: 600, useNativeDriver: true }),
        Animated.timing(carScale, { toValue: 1.0, duration: 600, useNativeDriver: true }),
      ]),
    ).start();

    // Loading dots: each loops fade-in/out independently, staggered by 250ms
    const createDotLoop = (opacity: Animated.Value) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ]),
      );

    const loop1 = createDotLoop(dot1Opacity);
    const loop2 = createDotLoop(dot2Opacity);
    const loop3 = createDotLoop(dot3Opacity);

    loop1.start();
    const t1 = setTimeout(() => loop2.start(), 250);
    const t2 = setTimeout(() => loop3.start(), 500);

    // After 2.5s, fade out entire screen then signal ready
    const dismiss = setTimeout(() => {
      Animated.timing(screenOpacity, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start(() => onReady());
    }, 2500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(dismiss);
      loop1.stop();
      loop2.stop();
      loop3.stop();
    };
  }, []);

  return (
    <Animated.View style={[styles.container, { opacity: screenOpacity }]}>
      {/* Subtle radial glow behind the car emoji */}
      <View style={styles.glowCircle} />

      {/* Car emoji with pulse */}
      <Animated.Text style={[styles.carEmoji, { transform: [{ scale: carScale }] }]}>
        🚗
      </Animated.Text>

      {/* CONVOY title */}
      <Text style={styles.title}>CONVOY</Text>

      {/* Crimson divider line */}
      <View style={styles.line} />

      {/* Loading dots */}
      <View style={styles.dotsContainer}>
        <Animated.View style={[styles.dot, { opacity: dot1Opacity }]} />
        <Animated.View style={[styles.dot, { opacity: dot2Opacity }]} />
        <Animated.View style={[styles.dot, { opacity: dot3Opacity }]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowCircle: {
    position: 'absolute',
    width: 150,
    height: 150,
    borderRadius: 100,
    backgroundColor: 'rgba(220,20,60,0.08)',
  },
  carEmoji: {
    fontSize: 72,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    letterSpacing: 8,
    marginTop: 20,
  },
  line: {
    width: 60,
    height: 2,
    backgroundColor: '#DC143C',
    marginVertical: 16,
  },
  dotsContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#DC143C',
  },
});

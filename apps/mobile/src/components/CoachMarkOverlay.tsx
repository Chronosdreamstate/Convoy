import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';

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

export default function CoachMarkOverlay({ visible, onComplete }: Props) {
  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setStep(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  function fadeToNext(nextStep: number) {
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

  async function handleGotIt() {
    if (step < HINTS.length - 1) {
      fadeToNext(step + 1);
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start(async () => {
        try {
          await AsyncStorage.setItem(STORAGE_KEY, '1');
        } catch {}
        onComplete();
      });
    }
  }

  if (!visible) return null;

  const hint = HINTS[step];

  return (
    <Modal transparent animationType="none" visible={visible} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
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
          <TouchableOpacity style={styles.gotItButton} onPress={handleGotIt} activeOpacity={0.8}>
            <Text style={styles.gotItText}>Got it</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.78)',
  },
  spotlight: {
    position: 'absolute',
    width: 128,
    height: 128,
    borderRadius: 64,
    borderWidth: 2,
    borderColor: '#DC143C',
    justifyContent: 'center',
    alignItems: 'center',
  },
  spotlightInner: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: 'rgba(220,20,60,0.12)',
  },
  tooltip: {
    position: 'absolute',
    backgroundColor: '#1C1C1C',
    borderRadius: 16,
    padding: 20,
    maxWidth: 280,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 12,
  },
  stepLabel: {
    color: '#888888',
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
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 6,
  },
  tooltipBody: {
    color: '#888888',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  gotItButton: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  gotItText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});

import { useEffect, useRef } from 'react';
import { Animated, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  visible: boolean;
  onEnable: () => void;
  onSkip: () => void;
}

export default function PushPermissionModal({ visible, onEnable, onSkip }: Props) {
  const scaleAnim = useRef(new Animated.Value(0.85)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, tension: 65, friction: 9, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      scaleAnim.setValue(0.85);
      opacityAnim.setValue(0);
    }
  }, [visible]);

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View style={[styles.card, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }]}>
          <Text style={styles.bell}>🔔</Text>
          <Text style={styles.headline}>Stay with your crew</Text>
          <Text style={styles.subheadline}>— even when signal drops</Text>
          <Text style={styles.body}>
            CONVOY alerts you when someone falls behind, an SOS is sent, or your group is about to leave
            without you. We only notify you when it matters.
          </Text>
          <View style={styles.bullets}>
            {[
              '👥  Someone falls behind',
              '🆘  SOS alert sent',
              '🏁  Your group is leaving',
            ].map((item) => (
              <Text key={item} style={styles.bullet}>{item}</Text>
            ))}
          </View>
          <TouchableOpacity style={styles.enableBtn} onPress={onEnable} activeOpacity={0.85}>
            <Text style={styles.enableText}>Enable Convoy Alerts</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onSkip} activeOpacity={0.7} style={styles.skipBtn}>
            <Text style={styles.skipText}>Maybe later</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 24,
    padding: 32,
    width: '100%',
    alignItems: 'center',
  },
  bell: { fontSize: 52, marginBottom: 16 },
  headline: { fontSize: 22, fontWeight: '700', color: '#FFFFFF', textAlign: 'center' },
  subheadline: { fontSize: 16, color: '#888888', textAlign: 'center', marginTop: 4, marginBottom: 16 },
  body: { fontSize: 14, color: '#888888', textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  bullets: { alignSelf: 'stretch', marginBottom: 28, gap: 10 },
  bullet: { fontSize: 14, color: '#FFFFFF', paddingLeft: 4 },
  enableBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    height: 56,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  enableText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  skipBtn: { paddingVertical: 4 },
  skipText: { fontSize: 14, color: '#888888' },
});

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';

export default function FindGroupPromptScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.heading}>Find your convoy 🏁</Text>
        <Text style={styles.convoy}>🚗🚙🚕</Text>
        <Text style={styles.body}>Connect with car enthusiasts in your area</Text>

        <View style={styles.cardRow}>
          <TouchableOpacity
            style={styles.card}
            onPress={() => router.replace('/group-browse' as never)}
            activeOpacity={0.8}
          >
            <Text style={styles.cardEmoji}>🔍</Text>
            <Text style={styles.cardTitle}>Browse Groups</Text>
            <Text style={styles.cardSub}>See open convoys near you</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.card}
            onPress={() => router.replace('/join' as never)}
            activeOpacity={0.8}
          >
            <Text style={styles.cardEmoji}>🔑</Text>
            <Text style={styles.cardTitle}>Enter Code</Text>
            <Text style={styles.cardSub}>Join with an invite code</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          onPress={() => router.replace('/(tabs)/map' as never)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.skipBtn}
        >
          <Text style={styles.skipText}>Take me to the map</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 20,
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  convoy: { fontSize: 52, letterSpacing: 4 },
  body: {
    fontSize: 15,
    color: '#888888',
    textAlign: 'center',
    marginBottom: 8,
  },
  cardRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  card: {
    flex: 1,
    backgroundColor: '#1C1C1C',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  cardEmoji: { fontSize: 32 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', textAlign: 'center' },
  cardSub: { fontSize: 12, color: '#888888', textAlign: 'center' },
  skipBtn: { marginTop: 8 },
  skipText: { fontSize: 14, color: '#555555' },
});

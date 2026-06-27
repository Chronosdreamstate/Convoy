import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../theme';

const SECTIONS = [
  {
    title: 'What We Collect',
    body: 'CONVOY collects the following data to provide the service:\n\n• Location — real-time GPS coordinates while a convoy is active\n• Phone number — used for account authentication via OTP\n• Display name and callsign — shown to other members of your convoys\n• Vehicle information — make, model, year, colour (optional)\n• Drive history — route traces, distance, duration, and speed statistics\n• Device push token — to deliver convoy alerts and notifications',
  },
  {
    title: 'How We Use Your Data',
    body: 'Your data is used exclusively to power CONVOY features:\n\n• Location is shared in real-time only with members of your active convoy\n• Drive history lets you replay and export past routes\n• Push tokens deliver time-sensitive alerts (SOS, gap warnings, convoy starts)\n\nWe do not sell, rent, or share your data with advertisers or third-party brokers. We do not build advertising profiles.',
  },
  {
    title: 'Data Retention',
    body: '• Real-time location data is held in memory during an active convoy and not persisted to disk beyond the drive record\n• Drive route traces are stored for 90 days and then permanently deleted\n• Account data (name, phone, vehicles) is retained until you delete your account\n• Push tokens are removed immediately when a device is unregistered or the token expires',
  },
  {
    title: 'Your Rights',
    body: 'You can:\n\n• Delete your account at any time from Settings → Delete Account. This permanently removes all personal data, drive history, and group memberships within 24 hours.\n• Export your drive history as CSV from the Drive History screen\n• Update or remove vehicle and profile information at any time\n• Revoke location permission via device settings — the app will not transmit location while permission is denied',
  },
  {
    title: 'Security',
    body: 'All data is transmitted over HTTPS/TLS. Location updates are sent only to members of your active convoy via authenticated, encrypted WebSocket connections. We use industry-standard practices for token storage and authentication.',
  },
  {
    title: 'Contact',
    body: 'Questions, deletion requests, or privacy concerns:\n\nmanjoytsunny13@gmail.com\n\nWe respond within 5 business days.',
  },
];

export default function PrivacyPolicyScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backArrow}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Privacy Policy</Text>
        <View style={styles.placeholder} />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.updated}>Last updated June 2026</Text>
        {SECTIONS.map((s) => (
          <View key={s.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{s.title}</Text>
            <Text style={styles.body}>{s.body}</Text>
          </View>
        ))}
        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  back: { width: 40, alignItems: 'flex-start' },
  backArrow: { fontSize: 28, color: theme.colors.text, lineHeight: 32 },
  title: { fontSize: 17, fontWeight: '600', color: theme.colors.text },
  placeholder: { width: 40 },
  scroll: { flex: 1 },
  content: { padding: 20 },
  updated: { fontSize: 12, color: theme.colors.textMuted, marginBottom: 24 },
  section: { marginBottom: 28 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: theme.colors.textMuted,
    lineHeight: 22,
  },
  bottomPad: { height: 40 },
});

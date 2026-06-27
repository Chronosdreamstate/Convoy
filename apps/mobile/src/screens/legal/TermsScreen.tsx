import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../theme';

const SECTIONS = [
  {
    title: '1. Acceptance',
    body: 'By creating a CONVOY account or using the app, you agree to these Terms of Service. If you do not agree, do not use the app.',
  },
  {
    title: '2. Eligibility',
    body: 'You must be 16 years of age or older to use CONVOY. By using the app you represent that you meet this requirement. CONVOY is intended for use by licensed drivers and passengers.',
  },
  {
    title: '3. Safe Use',
    body: 'You must not use CONVOY while operating a vehicle in a way that distracts from safe driving. Push-to-talk, map interaction, and alert responses must only be performed when it is safe to do so — pull over when in doubt. You are solely responsible for obeying all traffic laws while using the app.',
  },
  {
    title: '4. Acceptable Use',
    body: 'You agree not to:\n\n• Harass, threaten, or abuse other users\n• Transmit false SOS alerts\n• Use the app to coordinate illegal activity\n• Attempt to access other users\' location data without authorisation\n• Reverse-engineer, scrape, or attack CONVOY\'s servers',
  },
  {
    title: '5. User Content',
    body: 'You retain ownership of content you create (vehicle info, callsign, group names). By uploading content you grant CONVOY a non-exclusive licence to store and display it within the service. We reserve the right to remove content that violates these terms.',
  },
  {
    title: '6. Service Availability',
    body: 'CONVOY is provided on an "as is" basis. We do not guarantee uptime or accuracy of location data. Real-time features depend on network connectivity and GPS availability. Do not rely solely on CONVOY for safety-critical navigation.',
  },
  {
    title: '7. Termination',
    body: 'We may suspend or terminate accounts that violate these terms. You may delete your account at any time from Settings.',
  },
  {
    title: '8. Limitation of Liability',
    body: 'To the maximum extent permitted by law, CONVOY is not liable for damages arising from use of the app, including accidents, data loss, or service interruptions.',
  },
  {
    title: '9. Changes',
    body: 'We may update these terms. Continued use after notification of changes constitutes acceptance. Contact us at manjoytsunny13@gmail.com with any questions.',
  },
];

export default function TermsScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backArrow}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Terms of Service</Text>
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

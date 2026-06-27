import React, { useEffect, useState } from 'react';
import { View, Text, Switch, ScrollView, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PREFS_KEY = 'convoy:notif_prefs';

const SECTIONS = [
  {
    title: 'CONVOY',
    items: [
      { key: 'convoy_starting', label: 'Convoy Starting', desc: 'When your group begins a convoy' },
      { key: 'gap_alert', label: 'Gap Alert', desc: 'When you fall behind the convoy' },
      { key: 'sos_alert', label: 'SOS Alert', desc: 'Emergency alerts from group members' },
      { key: 'hazard_report', label: 'Hazard Report', desc: 'New hazards on your route' },
    ],
  },
  {
    title: 'GROUP',
    items: [
      { key: 'new_event', label: 'New Event', desc: 'When an event is scheduled' },
      { key: 'event_reminder', label: 'Event Reminder', desc: '1 hour before an event' },
      { key: 'new_member', label: 'New Member', desc: 'When someone joins your group' },
      { key: 'announcement', label: 'Announcement', desc: 'Group-wide announcements' },
    ],
  },
  {
    title: 'SOCIAL',
    items: [
      { key: 'friend_request', label: 'Friend Request', desc: 'When someone adds you' },
      { key: 'direct_message', label: 'Direct Message', desc: 'When you receive a DM' },
      { key: 'achievement', label: 'Achievement Unlocked', desc: 'When you earn a badge' },
    ],
  },
];

type Prefs = Record<string, boolean>;

export default function NotificationPreferencesScreen() {
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState<Prefs>({});

  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY).then((raw) => {
      if (raw) setPrefs(JSON.parse(raw));
      else {
        // Default all on
        const defaults: Prefs = {};
        SECTIONS.forEach(s => s.items.forEach(i => { defaults[i.key] = true; }));
        setPrefs(defaults);
      }
    });
  }, []);

  const toggle = async (key: string) => {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next));
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {SECTIONS.map(section => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.items.map((item, idx) => (
            <View key={item.key} style={[styles.row, idx < section.items.length - 1 && styles.rowBorder]}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{item.label}</Text>
                <Text style={styles.rowDesc}>{item.desc}</Text>
              </View>
              <Switch
                value={prefs[item.key] ?? true}
                onValueChange={() => toggle(item.key)}
                trackColor={{ false: '#2A2A2A', true: '#DC143C' }}
                thumbColor="#FFFFFF"
              />
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  section: { marginTop: 24, marginHorizontal: 16 },
  sectionTitle: { color: '#888888', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1C', paddingHorizontal: 16, paddingVertical: 14 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#2A2A2A' },
  rowText: { flex: 1, marginRight: 12 },
  rowLabel: { color: '#FFFFFF', fontSize: 15, fontWeight: '500' },
  rowDesc: { color: '#888888', fontSize: 12, marginTop: 2 },
});

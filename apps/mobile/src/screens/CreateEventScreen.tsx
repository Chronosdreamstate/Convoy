import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiClient } from '../services/apiClient';

export default function CreateEventScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const insets = useSafeAreaInsets();

  const [title, setTitle] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [hour, setHour] = useState('');
  const [minute, setMinute] = useState('');
  const [ampm, setAmpm] = useState<'AM' | 'PM'>('AM');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  function buildISO(): string | null {
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    const y = parseInt(year, 10);
    let h = parseInt(hour, 10);
    const min = parseInt(minute, 10);

    if (
      isNaN(m) || m < 1 || m > 12 ||
      isNaN(d) || d < 1 || d > 31 ||
      isNaN(y) || y < 2024 ||
      isNaN(h) || h < 1 || h > 12 ||
      isNaN(min) || min < 0 || min > 59
    ) return null;

    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;

    const date = new Date(y, m - 1, d, h, min, 0);
    if (date <= new Date()) return null;
    return date.toISOString();
  }

  const iso = buildISO();
  const isValid = title.trim().length > 0 && iso !== null;

  async function handleSubmit() {
    if (!isValid || !groupId) return;
    setLoading(true);
    try {
      const res = await apiClient.post<{ event: { id: string } }>(`/api/v1/groups/${groupId}/events`, {
        title: title.trim(),
        scheduledFor: iso,
        description: description.trim() || undefined,
      });
      const eventId = res.data?.event?.id;
      if (eventId) {
        router.replace({ pathname: '/event/[id]', params: { id: eventId, groupId } });
      } else {
        router.back();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to schedule event';
      Alert.alert('Error', msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.heading}>Schedule a Convoy</Text>
        <Text style={styles.sub}>Your crew will get a notification before it starts</Text>

        <Text style={styles.label}>Event title *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Sunday Morning Cruise"
          placeholderTextColor="#555"
          value={title}
          onChangeText={t => setTitle(t.slice(0, 100))}
          maxLength={100}
        />
        <Text style={styles.charCount}>{title.length}/100</Text>

        <Text style={styles.label}>Date *</Text>
        <View style={styles.dateRow}>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="MM"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            maxLength={2}
            value={month}
            onChangeText={setMonth}
          />
          <Text style={styles.dateSep}>/</Text>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="DD"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            maxLength={2}
            value={day}
            onChangeText={setDay}
          />
          <Text style={styles.dateSep}>/</Text>
          <TextInput
            style={[styles.input, styles.yearSegment]}
            placeholder="YYYY"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            maxLength={4}
            value={year}
            onChangeText={setYear}
          />
        </View>

        <Text style={styles.label}>Time *</Text>
        <View style={styles.timeRow}>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="HH"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            maxLength={2}
            value={hour}
            onChangeText={setHour}
          />
          <Text style={styles.dateSep}>:</Text>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="MM"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            maxLength={2}
            value={minute}
            onChangeText={setMinute}
          />
          <View style={styles.ampmRow}>
            {(['AM', 'PM'] as const).map(v => (
              <TouchableOpacity
                key={v}
                style={[styles.ampmPill, ampm === v && styles.ampmPillActive]}
                onPress={() => setAmpm(v)}
              >
                <Text style={[styles.ampmText, ampm === v && styles.ampmTextActive]}>{v}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <Text style={styles.label}>Description (optional)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Meeting point, route notes…"
          placeholderTextColor="#555"
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />

        <TouchableOpacity
          style={[styles.btn, (!isValid || loading) && styles.btnDisabled]}
          onPress={handleSubmit}
          disabled={!isValid || loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.btnText}>📅 Schedule Convoy</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  scroll: { flex: 1 },
  content: { padding: 20 },
  heading: { fontSize: 26, fontWeight: '800', color: '#FFFFFF', marginBottom: 6 },
  sub: { fontSize: 14, color: '#888', marginBottom: 28 },
  label: { fontSize: 12, fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 20 },
  input: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 12,
    color: '#FFFFFF',
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  charCount: { fontSize: 11, color: '#555', textAlign: 'right', marginTop: 4 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dateSegment: { flex: 1, textAlign: 'center', paddingHorizontal: 8 },
  yearSegment: { flex: 1.6, textAlign: 'center', paddingHorizontal: 8 },
  dateSep: { color: '#555', fontSize: 20, fontWeight: '300' },
  ampmRow: { flexDirection: 'row', gap: 6, marginLeft: 4 },
  ampmPill: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  ampmPillActive: { backgroundColor: '#DC143C', borderColor: '#DC143C' },
  ampmText: { color: '#888', fontSize: 13, fontWeight: '600' },
  ampmTextActive: { color: '#FFFFFF' },
  multiline: { minHeight: 100, paddingTop: 14 },
  btn: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 36,
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});

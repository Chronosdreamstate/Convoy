import React, { useMemo, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiClient } from '../services/apiClient';
import { ThemeColors, useTheme } from '../theme';

export default function CreateEventScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const insets = useSafeAreaInsets();
  const { colors, hitSlop } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [title, setTitle] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [hour, setHour] = useState('');
  const [minute, setMinute] = useState('');
  const [ampm, setAmpm] = useState<'AM' | 'PM'>('AM');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [touchedTitle, setTouchedTitle] = useState(false);
  const [touchedDate, setTouchedDate] = useState(false);
  const [touchedTime, setTouchedTime] = useState(false);

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

    // Date() silently rolls invalid day/month combinations (e.g. Feb 31 →
    // Mar 3) into the next month — reject any day the month doesn't have so
    // the event can never be scheduled on a date the user didn't type.
    if (d > new Date(y, m, 0).getDate()) return null;

    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;

    const date = new Date(y, m - 1, d, h, min, 0);
    if (date <= new Date()) return null;
    return date.toISOString();
  }

  const iso = buildISO();
  const isValid = title.trim().length > 0 && iso !== null;

  const titleError = touchedTitle && title.trim().length === 0
    ? 'Event title is required'
    : null;

  const dateTimeError = useMemo(() => {
    const anyFilled = month || day || year || hour || minute;
    if (!anyFilled) return null;
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    const y = parseInt(year, 10);
    const h = parseInt(hour, 10);
    const min = parseInt(minute, 10);
    if (!month || isNaN(m) || m < 1 || m > 12) return 'Enter a valid month (1-12)';
    if (!day || isNaN(d) || d < 1 || d > 31) return 'Enter a valid day (1-31)';
    if (!year || isNaN(y) || y < 2024) return 'Enter a valid 4-digit year';
    // Day-of-month check needs a valid month + year first (for leap years) —
    // catches combos like Feb 31 that pass the generic 1-31 range above.
    const daysInMonth = new Date(y, m, 0).getDate();
    if (d > daysInMonth) return `That month only has ${daysInMonth} days`;
    if (!hour || isNaN(h) || h < 1 || h > 12) return 'Enter a valid hour (1-12)';
    if (!minute || isNaN(min) || min < 0 || min > 59) return 'Enter a valid minute (0-59)';
    if (iso === null) return 'Choose a date and time in the future';
    return null;
  }, [month, day, year, hour, minute, iso]);

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
        router.replace({ pathname: '/event/[id]' as any, params: { id: eventId, groupId } });
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
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.heading}>Schedule a Convoy</Text>
        <Text style={styles.sub}>Your crew will get a notification before it starts</Text>

        <Text style={styles.label}>Event title *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Sunday Morning Cruise"
          placeholderTextColor={colors.textSubtle}
          value={title}
          onChangeText={t => setTitle(t.slice(0, 100))}
          onBlur={() => setTouchedTitle(true)}
          maxLength={100}
          accessibilityLabel="Event title"
        />
        <Text style={styles.charCount}>{title.length}/100</Text>
        {titleError ? <Text style={styles.errorText}>{titleError}</Text> : null}

        <Text style={styles.label}>Date *</Text>
        <View style={styles.dateRow}>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="MM"
            placeholderTextColor={colors.textSubtle}
            keyboardType="number-pad"
            maxLength={2}
            value={month}
            onChangeText={setMonth}
            onBlur={() => setTouchedDate(true)}
            accessibilityLabel="Month"
          />
          <Text style={styles.dateSep}>/</Text>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="DD"
            placeholderTextColor={colors.textSubtle}
            keyboardType="number-pad"
            maxLength={2}
            value={day}
            onChangeText={setDay}
            onBlur={() => setTouchedDate(true)}
            accessibilityLabel="Day"
          />
          <Text style={styles.dateSep}>/</Text>
          <TextInput
            style={[styles.input, styles.yearSegment]}
            placeholder="YYYY"
            placeholderTextColor={colors.textSubtle}
            keyboardType="number-pad"
            maxLength={4}
            value={year}
            onChangeText={setYear}
            onBlur={() => setTouchedDate(true)}
            accessibilityLabel="Year"
          />
        </View>

        <Text style={styles.label}>Time *</Text>
        <View style={styles.timeRow}>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="HH"
            placeholderTextColor={colors.textSubtle}
            keyboardType="number-pad"
            maxLength={2}
            value={hour}
            onChangeText={setHour}
            onBlur={() => setTouchedTime(true)}
            accessibilityLabel="Hour"
          />
          <Text style={styles.dateSep}>:</Text>
          <TextInput
            style={[styles.input, styles.dateSegment]}
            placeholder="MM"
            placeholderTextColor={colors.textSubtle}
            keyboardType="number-pad"
            maxLength={2}
            value={minute}
            onChangeText={setMinute}
            onBlur={() => setTouchedTime(true)}
            accessibilityLabel="Minute"
          />
          <View style={styles.ampmRow}>
            {(['AM', 'PM'] as const).map(v => (
              <TouchableOpacity
                key={v}
                style={[styles.ampmPill, ampm === v && styles.ampmPillActive]}
                onPress={() => setAmpm(v)}
                accessibilityRole="button"
                accessibilityLabel={v}
                accessibilityState={{ selected: ampm === v }}
                hitSlop={hitSlop}
              >
                <Text style={[styles.ampmText, ampm === v && styles.ampmTextActive]}>{v}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {(touchedDate || touchedTime) && dateTimeError ? (
          <Text style={styles.errorText}>{dateTimeError}</Text>
        ) : null}

        <Text style={styles.label}>Description (optional)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Meeting point, route notes…"
          placeholderTextColor={colors.textSubtle}
          value={description}
          onChangeText={(t) => setDescription(t.slice(0, 1000))}
          maxLength={1000}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          accessibilityLabel="Description"
        />

        <TouchableOpacity
          style={[styles.btn, (!isValid || loading) && styles.btnDisabled]}
          onPress={handleSubmit}
          disabled={!isValid || loading}
          accessibilityRole="button"
          accessibilityLabel="Schedule Convoy"
          accessibilityState={{ disabled: !isValid || loading, busy: loading }}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : (
              <View style={styles.btnContent}>
                <Ionicons name="calendar-outline" size={16} color="#FFFFFF" />
                <Text style={styles.btnText}> Schedule Convoy</Text>
              </View>
            )
          }
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    scroll: { flex: 1 },
    content: { padding: 20 },
    heading: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    sub: { fontSize: 14, color: colors.textMuted, marginBottom: 28 },
    label: { fontSize: 12, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 20 },
    input: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      color: colors.text,
      fontSize: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    charCount: { fontSize: 11, color: colors.textSubtle, textAlign: 'right', marginTop: 4 },
    errorText: { fontSize: 12, fontWeight: '500', color: colors.error, marginTop: 6 },
    dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dateSegment: { flex: 1, textAlign: 'center', paddingHorizontal: 8 },
    yearSegment: { flex: 1.6, textAlign: 'center', paddingHorizontal: 8 },
    dateSep: { color: colors.textSubtle, fontSize: 20, fontWeight: '300' },
    ampmRow: { flexDirection: 'row', gap: 6, marginLeft: 4 },
    ampmPill: {
      paddingHorizontal: 14,
      paddingVertical: 14,
      borderRadius: 10,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
    },
    ampmPillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    ampmText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
    ampmTextActive: { color: '#FFFFFF' },
    multiline: { minHeight: 100, paddingTop: 14 },
    btn: {
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingVertical: 18,
      alignItems: 'center',
      marginTop: 36,
    },
    btnDisabled: { opacity: 0.4 },
    btnContent: { flexDirection: 'row', alignItems: 'center' },
    btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  });
}

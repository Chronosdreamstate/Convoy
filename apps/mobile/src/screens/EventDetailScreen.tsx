import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiClient } from '../services/apiClient';
import { useAuthStore } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';
import { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { ThemeColors, useTheme, withAlpha } from '../theme';

type RsvpStatus = 'going' | 'maybe' | 'not_going';

interface RsvpEntry {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  callsign: string | null;
  status: RsvpStatus;
}

interface RsvpCounts {
  going: number;
  maybe: number;
  not_going: number;
}

interface EventData {
  id: string;
  title: string;
  description: string | null;
  scheduledFor: string;
  status: string;
  createdBy: string;
}

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function InitialsCircle({ name, size = 32, styles }: { name: string; size?: number; styles: ReturnType<typeof createStyles> }) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <View
      style={[
        styles.avatarCircle,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Text style={[styles.avatarInitials, { fontSize: size * 0.38 }]}>
        {initials}
      </Text>
    </View>
  );
}

export default function EventDetailScreen() {
  const { id: eventId, groupId } = useLocalSearchParams<{
    id: string;
    groupId: string;
  }>();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const resolvedGroupId = groupId ?? activeGroupId ?? '';
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [event, setEvent] = useState<EventData | null>(null);
  const [rsvps, setRsvps] = useState<RsvpEntry[]>([]);
  const [counts, setCounts] = useState<RsvpCounts>({ going: 0, maybe: 0, not_going: 0 });
  const [myStatus, setMyStatus] = useState<RsvpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [rsvpLoading, setRsvpLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const isAdmin = event?.createdBy === user?.id;

  const load = useCallback(async () => {
    if (!resolvedGroupId || !eventId) return;
    setLoading(true);
    try {
      const [eventsRes, rsvpRes] = await Promise.all([
        apiClient.get<{ events: EventData[] }>(
          `/api/v1/groups/${resolvedGroupId}/events`,
        ),
        apiClient.get<{ rsvps: RsvpEntry[]; counts: RsvpCounts; myStatus: RsvpStatus | null }>(
          `/api/v1/groups/${resolvedGroupId}/events/${eventId}/rsvps`,
        ),
      ]);
      const found = eventsRes.data.events.find((e) => e.id === eventId);
      if (found) setEvent(found);
      setRsvps(rsvpRes.data.rsvps);
      setCounts(rsvpRes.data.counts);
      setMyStatus(rsvpRes.data.myStatus);
    } catch {
      // keep showing whatever we have
    } finally {
      setLoading(false);
    }
  }, [resolvedGroupId, eventId]);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function handleRsvp(status: RsvpStatus) {
    if (!resolvedGroupId || !eventId) return;
    setRsvpLoading(true);
    try {
      const res = await apiClient.post<{ rsvp: { status: string }; counts: RsvpCounts }>(
        `/api/v1/groups/${resolvedGroupId}/events/${eventId}/rsvp`,
        { status },
      );
      setMyStatus(res.data.rsvp.status as RsvpStatus);
      setCounts(res.data.counts);
      void load();
      if (status === 'going' && event) {
        setTimeout(() => {
          void Share.share({
            message: [
              `I'm going to "${event.title}" on CORTEGE! 🏎️`,
              `📅 ${formatEventDate(event.scheduledFor)}`,
              '',
              'Join us: convoy.app',
            ].join('\n'),
            title: event.title,
          });
        }, 600);
      }
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not update RSVP');
    } finally {
      setRsvpLoading(false);
    }
  }

  async function handleRemindAll() {
    if (!resolvedGroupId || !eventId) return;
    try {
      await apiClient.post(`/api/v1/groups/${resolvedGroupId}/events/${eventId}/remind`);
      Alert.alert('Reminder sent', 'All members have been notified about this event.');
    } catch {
      Alert.alert('Error', 'Could not send reminder');
    }
  }

  const goingRsvps = rsvps.filter((r) => r.status === 'going');

  if (loading) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <TouchableOpacity style={styles.backRow} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={14} color={colors.accent} />
          <Text style={styles.backLink}> Back</Text>
        </TouchableOpacity>
        <View style={{ padding: 16, gap: 16 }}>
          <SkeletonBox width="70%" height={28} />
          <SkeletonBox width="40%" height={16} />
          <SkeletonBox width="100%" height={100} borderRadius={12} />
          <SkeletonBox width="100%" height={60} borderRadius={12} />
          <SkeletonBox width="100%" height={44} borderRadius={12} />
        </View>
      </View>
    );
  }

  if (!event) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <TouchableOpacity style={styles.backRow} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={14} color={colors.accent} />
          <Text style={styles.backLink}> Back</Text>
        </TouchableOpacity>
        <NetworkError onRetry={() => void load()} message="Event not found." />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
      }
    >
      {/* Header */}
      <View style={[styles.headerRow, { paddingTop: insets.top + 16 }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Event Details</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Event card */}
      <View style={styles.card}>
        <Text style={styles.eventTitle}>{event.title}</Text>
        <Text style={styles.eventDate}>
          <Ionicons name="calendar-outline" size={13} color={colors.accent} /> {formatEventDate(event.scheduledFor)}
        </Text>
        {event.description ? (
          <Text style={styles.eventDesc}>{event.description}</Text>
        ) : null}
      </View>

      {/* RSVP counts */}
      <View style={styles.countsRow}>
        <View style={styles.countChip}>
          <Text style={styles.countNumber}>{counts.going}</Text>
          <Text style={styles.countLabel}>Going</Text>
        </View>
        <View style={styles.countDivider} />
        <View style={styles.countChip}>
          <Text style={styles.countNumber}>{counts.maybe}</Text>
          <Text style={styles.countLabel}>Maybe</Text>
        </View>
        <View style={styles.countDivider} />
        <View style={styles.countChip}>
          <Text style={styles.countNumber}>{counts.not_going}</Text>
          <Text style={styles.countLabel}>Can't Go</Text>
        </View>
      </View>

      {/* RSVP buttons */}
      <Text style={styles.sectionLabel}>YOUR RSVP</Text>
      <View style={styles.rsvpRow}>
        {(
          [
            { status: 'going' as RsvpStatus, icon: 'checkmark-circle' as const, label: 'Going' },
            { status: 'maybe' as RsvpStatus, icon: 'help-circle-outline' as const, label: 'Maybe' },
            { status: 'not_going' as RsvpStatus, icon: 'close-circle-outline' as const, label: "Can't Go" },
          ] as const
        ).map(({ status, icon, label }) => {
          const active = myStatus === status;
          return (
            <TouchableOpacity
              key={status}
              style={[styles.rsvpPill, active && styles.rsvpPillActive]}
              onPress={() => { void handleRsvp(status); }}
              disabled={rsvpLoading}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: rsvpLoading }}
            >
              <Ionicons name={icon} size={14} color={active ? colors.text : colors.textMuted} />
              <Text style={[styles.rsvpPillText, active && styles.rsvpPillTextActive]}> {label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Going avatars */}
      {goingRsvps.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>GOING ({goingRsvps.length})</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.avatarScroll}>
            {goingRsvps.slice(0, 12).map((r) => (
              <View key={r.userId} style={styles.avatarItem}>
                <InitialsCircle name={r.callsign ?? r.displayName} size={40} styles={styles} />
                <Text style={styles.avatarName} numberOfLines={1}>
                  {r.callsign ?? r.displayName.split(' ')[0]}
                </Text>
              </View>
            ))}
          </ScrollView>
        </>
      )}

      {/* Full RSVP list */}
      {rsvps.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>ALL RESPONSES</Text>
          {rsvps.map((r) => (
            <View key={r.userId} style={styles.rsvpListRow}>
              <InitialsCircle name={r.callsign ?? r.displayName} size={36} styles={styles} />
              <View style={styles.rsvpListInfo}>
                <Text style={styles.rsvpListName}>
                  {r.callsign ?? r.displayName}
                </Text>
              </View>
              <View
                style={[
                  styles.statusBadge,
                  r.status === 'going' && styles.badgeGoing,
                  r.status === 'maybe' && styles.badgeMaybe,
                  r.status === 'not_going' && styles.badgeNotGoing,
                ]}
              >
                <Text style={styles.statusBadgeText}>
                  {r.status === 'going' ? 'Going' : r.status === 'maybe' ? 'Maybe' : "Can't Go"}
                </Text>
              </View>
            </View>
          ))}
        </>
      )}

      {/* Admin: remind all */}
      {isAdmin && (
        <TouchableOpacity style={styles.remindBtn} onPress={() => { void handleRemindAll(); }}>
          <Ionicons name="megaphone-outline" size={15} color={colors.text} />
          <Text style={styles.remindBtnText}> Remind All Members</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12 },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  content: { paddingHorizontal: 16 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  screenTitle: { fontSize: 17, fontWeight: '700', color: colors.text },

  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 20,
  },
  eventTitle: { fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 8 },
  eventDate: { fontSize: 15, color: colors.accent, fontWeight: '600', marginBottom: 8 },
  eventDesc: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },

  countsRow: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 24,
    overflow: 'hidden',
  },
  countChip: { flex: 1, paddingVertical: 16, alignItems: 'center' },
  countNumber: { fontSize: 22, fontWeight: '800', color: colors.text },
  countLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  countDivider: { width: 1, backgroundColor: colors.border, marginVertical: 10 },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },

  rsvpRow: { flexDirection: 'row', gap: 8, marginBottom: 24 },
  rsvpPill: {
    flex: 1,
    flexDirection: 'row',
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  rsvpPillActive: { borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.1) },
  rsvpPillText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  rsvpPillTextActive: { color: colors.text },

  avatarScroll: { marginBottom: 24 },
  avatarItem: { alignItems: 'center', marginRight: 14, maxWidth: 52 },
  avatarCircle: { backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { color: '#FFFFFF', fontWeight: '700' },
  avatarName: { fontSize: 10, color: colors.textMuted, marginTop: 4, textAlign: 'center' },

  rsvpListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.card,
    gap: 12,
  },
  rsvpListInfo: { flex: 1 },
  rsvpListName: { fontSize: 15, fontWeight: '600', color: colors.text },

  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeGoing: { backgroundColor: withAlpha(colors.success, 0.18) },
  badgeMaybe: { backgroundColor: withAlpha(colors.warning, 0.18) },
  badgeNotGoing: { backgroundColor: withAlpha(colors.error, 0.18) },
  statusBadgeText: { fontSize: 12, fontWeight: '600', color: colors.text },

  remindBtn: {
    marginTop: 24,
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  remindBtnText: { fontSize: 15, fontWeight: '600', color: colors.text },

  emptyText: { fontSize: 16, color: colors.textMuted },
  backLink: { fontSize: 14, color: colors.accent },
  });
}

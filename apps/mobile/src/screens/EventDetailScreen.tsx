import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiClient } from '../services/apiClient';
import { useAuthStore } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';
import { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';

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

function InitialsCircle({ name, size = 32 }: { name: string; size?: number }) {
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
              `I'm going to "${event.title}" on CONVOY! 🏎️`,
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
          <Text style={styles.backLink}>‹ Back</Text>
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
          <Text style={styles.backLink}>‹ Back</Text>
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
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#DC143C" colors={['#DC143C']} />
      }
    >
      {/* Header */}
      <View style={[styles.headerRow, { paddingTop: insets.top + 16 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Event Details</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Event card */}
      <View style={styles.card}>
        <Text style={styles.eventTitle}>{event.title}</Text>
        <Text style={styles.eventDate}>📅 {formatEventDate(event.scheduledFor)}</Text>
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
            { status: 'going' as RsvpStatus, label: '✅ Going' },
            { status: 'maybe' as RsvpStatus, label: '🤔 Maybe' },
            { status: 'not_going' as RsvpStatus, label: '❌ Can\'t Go' },
          ] as const
        ).map(({ status, label }) => {
          const active = myStatus === status;
          return (
            <TouchableOpacity
              key={status}
              style={[styles.rsvpPill, active && styles.rsvpPillActive]}
              onPress={() => { void handleRsvp(status); }}
              disabled={rsvpLoading}
            >
              <Text style={[styles.rsvpPillText, active && styles.rsvpPillTextActive]}>
                {label}
              </Text>
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
                <InitialsCircle name={r.callsign ?? r.displayName} size={40} />
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
              <InitialsCircle name={r.callsign ?? r.displayName} size={36} />
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
          <Text style={styles.remindBtnText}>📢 Remind All Members</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  center: { flex: 1, backgroundColor: '#0A0A0A', alignItems: 'center', justifyContent: 'center', gap: 12 },
  backRow: { paddingHorizontal: 16, paddingVertical: 12 },
  content: { paddingHorizontal: 16 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backArrow: { fontSize: 24, color: '#FFFFFF' },
  screenTitle: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },

  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginBottom: 20,
  },
  eventTitle: { fontSize: 22, fontWeight: '800', color: '#FFFFFF', marginBottom: 8 },
  eventDate: { fontSize: 15, color: '#DC143C', fontWeight: '600', marginBottom: 8 },
  eventDesc: { fontSize: 14, color: '#888', lineHeight: 20 },

  countsRow: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginBottom: 24,
    overflow: 'hidden',
  },
  countChip: { flex: 1, paddingVertical: 16, alignItems: 'center' },
  countNumber: { fontSize: 22, fontWeight: '800', color: '#FFFFFF' },
  countLabel: { fontSize: 11, color: '#888', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  countDivider: { width: 1, backgroundColor: '#2A2A2A', marginVertical: 10 },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },

  rsvpRow: { flexDirection: 'row', gap: 8, marginBottom: 24 },
  rsvpPill: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
  },
  rsvpPillActive: { borderColor: '#DC143C', backgroundColor: '#1A0508' },
  rsvpPillText: { fontSize: 12, fontWeight: '600', color: '#888' },
  rsvpPillTextActive: { color: '#FFFFFF' },

  avatarScroll: { marginBottom: 24 },
  avatarItem: { alignItems: 'center', marginRight: 14, maxWidth: 52 },
  avatarCircle: { backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { color: '#FFFFFF', fontWeight: '700' },
  avatarName: { fontSize: 10, color: '#888', marginTop: 4, textAlign: 'center' },

  rsvpListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1C',
    gap: 12,
  },
  rsvpListInfo: { flex: 1 },
  rsvpListName: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },

  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeGoing: { backgroundColor: '#0F2A18' },
  badgeMaybe: { backgroundColor: '#2A1F06' },
  badgeNotGoing: { backgroundColor: '#2A0A0A' },
  statusBadgeText: { fontSize: 12, fontWeight: '600', color: '#FFFFFF' },

  remindBtn: {
    marginTop: 24,
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  remindBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },

  emptyText: { fontSize: 16, color: '#888' },
  backLink: { fontSize: 14, color: '#DC143C' },
});

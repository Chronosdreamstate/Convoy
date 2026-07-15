import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const { colors, hitSlop } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [event, setEvent] = useState<EventData | null>(null);
  const [rsvps, setRsvps] = useState<RsvpEntry[]>([]);
  const [counts, setCounts] = useState<RsvpCounts>({ going: 0, maybe: 0, not_going: 0 });
  const [myStatus, setMyStatus] = useState<RsvpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinguishes "the fetch failed" (network/server — retry makes sense)
  // from "the fetch worked but the event is gone" (it passed or was
  // cancelled — retrying will never bring it back).
  const [loadError, setLoadError] = useState(false);
  const [rsvpLoadingStatus, setRsvpLoadingStatus] = useState<RsvpStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sharingEvent, setSharingEvent] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const isAdmin = event?.createdBy === user?.id;

  const hasLoadedRef = useRef(false);
  const load = useCallback(async () => {
    if (!resolvedGroupId || !eventId) return;
    // Only show the full-screen skeleton on the initial load. Pull-to-refresh
    // (onRefresh) also calls load(); without this guard it blanked the loaded
    // event back to the skeleton and dropped the RefreshControl spinner. Uses a
    // ref (not `event`) so load()'s identity stays stable and can't refetch-loop.
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const [eventsRes, rsvpRes] = await Promise.all([
        apiClient.get<{ events: EventData[] }>(
          `/api/v1/groups/${resolvedGroupId}/events`,
        ),
        apiClient.get<{ rsvps: RsvpEntry[]; counts: RsvpCounts; myStatus: RsvpStatus | null }>(
          `/api/v1/groups/${resolvedGroupId}/events/${eventId}/rsvps`,
        ),
      ]);
      // The events list only carries upcoming events — a fetch that succeeds
      // but doesn't contain this id means the event passed or was cancelled,
      // which is a real answer, not an error.
      const found = eventsRes.data.events.find((e) => e.id === eventId);
      if (found) setEvent(found);
      setRsvps(rsvpRes.data.rsvps);
      setCounts(rsvpRes.data.counts);
      setMyStatus(rsvpRes.data.myStatus);
      setLoadError(false);
      hasLoadedRef.current = true;
    } catch {
      // keep showing whatever we have; only flag a hard error when there's
      // nothing on screen to fall back to
      setLoadError(true);
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
    setRsvpLoadingStatus(status);
    try {
      const res = await apiClient.post<{ rsvp: { status: string }; counts: RsvpCounts }>(
        `/api/v1/groups/${resolvedGroupId}/events/${eventId}/rsvp`,
        { status },
      );
      setMyStatus(res.data.rsvp.status as RsvpStatus);
      setCounts(res.data.counts);
      void load();
      // NOTE: do not auto-open the share sheet here — tapping "Going" is an RSVP,
      // not a share. Sharing is an explicit action via the Share button (which
      // calls handleShareEvent); auto-firing it hijacked the screen every time.
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not update RSVP');
    } finally {
      setRsvpLoadingStatus(null);
    }
  }

  async function handleShareEvent() {
    if (!event) return;
    setSharingEvent(true);
    try {
      await Share.share({
        title: event.title,
        message: [
          `Join me at "${event.title}" on CORTEGE! 🏎️`,
          `📅 ${formatEventDate(event.scheduledFor)}`,
          '',
          'Join us: convoy.app',
        ].join('\n'),
      });
    } catch {
      Alert.alert('Error', 'Could not open share sheet');
    } finally {
      setSharingEvent(false);
    }
  }

  // Cancel is a group-admin action on the API (DELETE returns 403 for anyone
  // else), so it's gated behind the same isAdmin flag as "Remind All". The
  // confirm dialog is explicit that everyone who RSVP'd loses the event.
  function handleCancelEvent() {
    if (!resolvedGroupId || !eventId || !event) return;
    Alert.alert(
      'Cancel Event',
      `Cancel "${event.title}"? Members who RSVP'd will no longer see this event. This cannot be undone.`,
      [
        { text: 'Keep Event', style: 'cancel' },
        {
          text: 'Cancel Event',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            try {
              await apiClient.delete(`/api/v1/groups/${resolvedGroupId}/events/${eventId}`);
              Alert.alert('Event cancelled', 'This event has been removed from the group schedule.');
              router.back();
            } catch (err: unknown) {
              const status = (err as { status?: number }).status;
              Alert.alert(
                'Error',
                status === 403
                  ? 'Only the group admin can cancel this event.'
                  : 'Could not cancel the event. Please try again.',
              );
            } finally {
              setCancelling(false);
            }
          },
        },
      ],
    );
  }

  async function handleRemindAll() {
    if (!resolvedGroupId || !eventId) return;
    setReminding(true);
    try {
      await apiClient.post(`/api/v1/groups/${resolvedGroupId}/events/${eventId}/remind`);
      Alert.alert('Reminder sent', 'All members have been notified about this event.');
    } catch {
      Alert.alert('Error', 'Could not send reminder');
    } finally {
      setReminding(false);
    }
  }

  const goingRsvps = rsvps.filter((r) => r.status === 'going');

  if (loading) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <TouchableOpacity
          style={styles.backRow}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={hitSlop}
        >
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
        <TouchableOpacity
          style={styles.backRow}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={hitSlop}
        >
          <Ionicons name="chevron-back" size={14} color={colors.accent} />
          <Text style={styles.backLink}> Back</Text>
        </TouchableOpacity>
        {loadError ? (
          // The fetch itself failed — retrying can genuinely help.
          <NetworkError onRetry={() => void load()} message="Could not load this event. Check your connection." />
        ) : (
          // The fetch worked but the event is gone (passed or cancelled) —
          // a retry button here would be a lie, offer the way back instead.
          <View style={styles.goneWrap}>
            <Ionicons name="calendar-outline" size={44} color={colors.textMuted} />
            <Text style={styles.goneTitle}>Event unavailable</Text>
            <Text style={styles.goneText}>This event has already happened or was cancelled.</Text>
            <TouchableOpacity
              style={styles.goneBackBtn}
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Go back to previous screen"
            >
              <Text style={styles.goneBackText}>Go Back</Text>
            </TouchableOpacity>
          </View>
        )}
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
        <TouchableOpacity
          onPress={() => { void handleShareEvent(); }}
          style={styles.backBtn}
          disabled={sharingEvent}
          accessibilityRole="button"
          accessibilityLabel="Share event"
          accessibilityState={{ busy: sharingEvent }}
        >
          {sharingEvent
            ? <ActivityIndicator size="small" color={colors.text} />
            : <Ionicons name="share-social-outline" size={22} color={colors.text} />
          }
        </TouchableOpacity>
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
          const isLoadingThis = rsvpLoadingStatus === status;
          return (
            <TouchableOpacity
              key={status}
              style={[styles.rsvpPill, active && styles.rsvpPillActive]}
              onPress={() => { void handleRsvp(status); }}
              disabled={rsvpLoadingStatus !== null}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: active, disabled: rsvpLoadingStatus !== null, busy: isLoadingThis }}
            >
              {isLoadingThis
                ? <ActivityIndicator size="small" color={active ? colors.text : colors.textMuted} />
                : <Ionicons name={icon} size={14} color={active ? colors.text : colors.textMuted} />
              }
              <Text style={[styles.rsvpPillText, active && styles.rsvpPillTextActive]}> {label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {rsvps.length === 0 ? (
        <View style={styles.emptyAttendees}>
          <Ionicons name="people-outline" size={28} color={colors.textSubtle} />
          <Text style={styles.emptyAttendeesText}>No responses yet — be the first to RSVP!</Text>
        </View>
      ) : (
        <>
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
        <TouchableOpacity
          style={[styles.remindBtn, reminding && styles.remindBtnDisabled]}
          onPress={() => { void handleRemindAll(); }}
          disabled={reminding}
          accessibilityRole="button"
          accessibilityLabel="Remind all members"
          accessibilityState={{ busy: reminding, disabled: reminding }}
        >
          {reminding
            ? <ActivityIndicator size="small" color={colors.text} />
            : <Ionicons name="megaphone-outline" size={15} color={colors.text} />
          }
          <Text style={styles.remindBtnText}> {reminding ? 'Sending…' : 'Remind All Members'}</Text>
        </TouchableOpacity>
      )}

      {/* Admin: cancel event */}
      {isAdmin && (
        <TouchableOpacity
          style={[styles.cancelBtn, cancelling && styles.remindBtnDisabled]}
          onPress={handleCancelEvent}
          disabled={cancelling}
          accessibilityRole="button"
          accessibilityLabel="Cancel event"
          accessibilityState={{ busy: cancelling, disabled: cancelling }}
        >
          {cancelling
            ? <ActivityIndicator size="small" color={colors.error} />
            : <Ionicons name="trash-outline" size={15} color={colors.error} />
          }
          <Text style={styles.cancelBtnText}> {cancelling ? 'Cancelling…' : 'Cancel Event'}</Text>
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

  emptyAttendees: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 24,
    gap: 10,
  },
  emptyAttendeesText: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },

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
  remindBtnDisabled: { opacity: 0.6 },

  cancelBtn: {
    marginTop: 12,
    flexDirection: 'row',
    backgroundColor: withAlpha(colors.error, 0.08),
    borderWidth: 1,
    borderColor: withAlpha(colors.error, 0.4),
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: { fontSize: 15, fontWeight: '600', color: colors.error },

  emptyText: { fontSize: 16, color: colors.textMuted },
  backLink: { fontSize: 14, color: colors.accent },

  goneWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  goneTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 4 },
  goneText: { color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  goneBackBtn: {
    marginTop: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, minHeight: 44, justifyContent: 'center',
  },
  goneBackText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  });
}

/**
 * GroupEventsScreen — full list of a group's upcoming scheduled events.
 *
 * Reached from GroupDetailScreen / ConvoyScreen via "See all events".
 * API: GET /api/v1/groups/{groupId}/events → { events, total? }
 * Each row shows name / date / the current user's RSVP status (`myRsvp`,
 * joined into the list response server-side — no per-event fetches) and
 * navigates to the existing /event/[id] detail screen (where the RSVP is made).
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { SkeletonRow } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { apiClient } from '../services/apiClient';
import { ThemeColors, useTheme, withAlpha } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RsvpStatus = 'going' | 'maybe' | 'not_going';

interface GroupEvent {
  id: string;
  title: string;
  description: string | null;
  scheduledFor: string;
  status: string;
  createdBy: string;
  /**
   * The caller's own RSVP, included in the list response server-side.
   * `null` = member hasn't RSVPed yet (show the "RSVP ›" nudge);
   * `undefined` = older API without the field → hide the pill entirely
   * rather than show a misleading cta.
   */
  myRsvp?: RsvpStatus | null;
}

interface EventsResponse {
  events: GroupEvent[];
  /** Total upcoming events — being added server-side; optional until it lands. */
  total?: number;
}

const SKELETON_COUNT = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Today" / "Tomorrow" / "In N days" for events within a week, else null. */
function relativeDayLabel(iso: string): string | null {
  const now = new Date();
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfEventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfEventDay - startOfToday) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return `In ${diffDays} days`;
  return null;
}

const RSVP_LABELS: Record<RsvpStatus, string> = {
  going: 'Going',
  maybe: 'Maybe',
  not_going: "Can't Go",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RsvpPill({ status, styles }: { status: RsvpStatus | null; styles: Styles }) {
  if (status === null) {
    // Member hasn't responded yet — nudge them toward the detail screen.
    return (
      <View style={[styles.rsvpPill, styles.rsvpPillNone]}>
        <Text style={styles.rsvpPillNoneText}>RSVP ›</Text>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.rsvpPill,
        status === 'going' && styles.rsvpPillGoing,
        status === 'maybe' && styles.rsvpPillMaybe,
        status === 'not_going' && styles.rsvpPillNotGoing,
      ]}
    >
      <Text
        style={[
          styles.rsvpPillText,
          status === 'going' && styles.rsvpPillTextGoing,
          status === 'maybe' && styles.rsvpPillTextMaybe,
          status === 'not_going' && styles.rsvpPillTextNotGoing,
        ]}
      >
        {RSVP_LABELS[status]}
      </Text>
    </View>
  );
}

function EventRow({
  event,
  myRsvp,
  onPress,
  styles,
  colors,
}: {
  event: GroupEvent;
  myRsvp: RsvpStatus | null | undefined;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const d = new Date(event.scheduledFor);
  const month = d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
  const day = d.getDate();
  const relative = relativeDayLabel(event.scheduledFor);
  const rsvpForA11y =
    myRsvp === undefined
      ? ''
      : myRsvp === null
        ? '. You have not RSVPed yet'
        : `. Your RSVP: ${RSVP_LABELS[myRsvp]}`;

  return (
    <TouchableOpacity
      style={styles.eventRow}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${formatEventDate(event.scheduledFor)}${rsvpForA11y}. Opens event details`}
    >
      {/* Date bubble */}
      <View style={styles.dateBubble}>
        <Text style={styles.dateBubbleMonth}>{month}</Text>
        <Text style={styles.dateBubbleDay}>{day}</Text>
      </View>

      {/* Title + when */}
      <View style={styles.eventInfo}>
        <Text style={styles.eventTitle} numberOfLines={1}>
          {event.title}
        </Text>
        <Text style={styles.eventWhen} numberOfLines={1}>
          {formatEventDate(event.scheduledFor)}
        </Text>
        {relative ? <Text style={styles.eventRelative}>{relative}</Text> : null}
      </View>

      {/* RSVP status + chevron */}
      <View style={styles.eventRight}>
        {myRsvp !== undefined && <RsvpPill status={myRsvp} styles={styles} />}
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function GroupEventsScreen() {
  const { colors, spacing, radius, typography, hitSlop } = useTheme();
  const styles = useMemo(
    () => createStyles(colors, spacing, radius, typography),
    [colors, spacing, radius, typography],
  );

  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; groupName?: string }>();
  const groupId = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const groupName = Array.isArray(params.groupName) ? params.groupName[0] : params.groupName;

  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const hasLoadedRef = useRef(false);

  const load = useCallback(
    async (silent: boolean) => {
      if (!groupId) {
        setLoading(false);
        setError(true);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const res = await apiClient.get<EventsResponse>(`/api/v1/groups/${groupId}/events`);
        // Each event carries the caller's own RSVP (`myRsvp`) inline — no
        // per-event /rsvps fetches needed. Older APIs omit the field, which
        // simply hides the pill.
        setEvents(res.data.events ?? []);
        setTotal(typeof res.data.total === 'number' ? res.data.total : null);
        setError(false);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [groupId],
  );

  // Reload on every focus so an RSVP made on the detail screen is reflected
  // when the user comes back. First load shows the skeleton; later focuses
  // refresh silently to avoid a flash.
  useFocusEffect(
    useCallback(() => {
      void load(hasLoadedRef.current);
      hasLoadedRef.current = true;
    }, [load]),
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const openEvent = useCallback(
    (eventId: string) => {
      router.push({
        pathname: '/event/[id]',
        params: { id: eventId, groupId },
      } as never);
    },
    [router, groupId],
  );

  const renderItem = useCallback(
    ({ item }: { item: GroupEvent }) => (
      <EventRow
        event={item}
        myRsvp={item.myRsvp}
        onPress={() => openEvent(item.id)}
        styles={styles}
        colors={colors}
      />
    ),
    [openEvent, styles, colors],
  );

  // Req 33 — while the vehicle is in motion, cap the list to 4 events with a
  // "pull over to see more" notice. The sub-header count keeps reporting the
  // full total so the driver knows nothing was lost.
  const { data: visibleEvents, hiddenCount: hiddenEventCount } = useMotionCappedData(events);

  const countLabel =
    total !== null && total > events.length
      ? `Showing ${events.length} of ${total} upcoming`
      : `${events.length} upcoming`;

  const header = (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={handleBack}
        hitSlop={hitSlop}
        style={styles.backButton}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="chevron-back" size={22} color={colors.accent} />
        <Text style={styles.backButtonText}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Events</Text>
      {/* Phantom view to balance flex layout */}
      <View style={styles.headerSpacer} />
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        {header}
        <View style={styles.skeletonList}>
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <View key={i} style={styles.skeletonWrapper}>
              <SkeletonRow />
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  if (error && events.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        {header}
        <NetworkError
          onRetry={() => void load(false)}
          message="Could not load this group's events."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {header}
      {groupName || events.length > 0 ? (
        <View style={styles.subHeader}>
          {groupName ? (
            <Text style={styles.subHeaderGroup} numberOfLines={1}>
              {groupName}
            </Text>
          ) : null}
          {events.length > 0 ? <Text style={styles.subHeaderCount}>{countLabel}</Text> : null}
        </View>
      ) : null}

      <FlatList
        data={visibleEvents}
        keyExtractor={(item) => item.id}
        contentContainerStyle={events.length === 0 ? styles.listEmpty : styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
        ListHeaderComponent={
          error ? (
            <Text style={styles.errorBanner}>Couldn&apos;t refresh — showing last loaded events</Text>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name="calendar-outline"
              size={52}
              color={colors.textMuted}
              style={styles.emptyIcon}
            />
            <Text style={styles.emptyTitle}>No upcoming events</Text>
            <Text style={styles.emptySubtitle}>
              When the group admin schedules a drive, it will show up here.
            </Text>
          </View>
        }
        renderItem={renderItem}
        ListFooterComponent={<MotionCapNotice hiddenCount={hiddenEventCount} />}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(
  colors: ThemeColors,
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number },
  radius: { sm: number; md: number; lg: number; xl: number; pill: number },
  typography: Record<string, { fontSize: number; fontWeight: '900' | '700' | '400' | '600'; letterSpacing?: number }>,
) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },

    // Header
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 60,
      minHeight: 44,
    },
    backButtonText: {
      color: colors.accent,
      fontSize: 17,
      fontWeight: '600',
      marginLeft: 2,
    },
    headerTitle: {
      flex: 1,
      color: colors.text,
      ...typography.heading,
      textAlign: 'center',
    },
    headerSpacer: {
      minWidth: 60,
    },

    // Sub-header (group name + count)
    subHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
    },
    subHeaderGroup: {
      flexShrink: 1,
      color: colors.textMuted,
      ...typography.label,
    },
    subHeaderCount: {
      color: colors.textSubtle,
      ...typography.caption,
      flexShrink: 0,
    },

    // List
    list: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.xl,
    },
    listEmpty: {
      flexGrow: 1,
      paddingHorizontal: spacing.md,
    },
    errorBanner: {
      color: colors.error,
      fontSize: 12,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },

    // Skeleton
    skeletonList: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.xs,
      gap: spacing.sm,
    },
    skeletonWrapper: {
      backgroundColor: colors.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
    },

    // Event row
    eventRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 10,
      paddingVertical: spacing.md - 2,
      paddingHorizontal: spacing.md,
      gap: spacing.md - 4,
      minHeight: 72,
    },
    dateBubble: {
      width: 48,
      height: 52,
      borderRadius: radius.sm + 2,
      backgroundColor: withAlpha(colors.warning, 0.12),
      borderWidth: 1,
      borderColor: withAlpha(colors.warning, 0.4),
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    dateBubbleMonth: {
      color: colors.warning,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1,
    },
    dateBubbleDay: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '700',
      marginTop: 1,
    },
    eventInfo: {
      flex: 1,
      gap: 2,
    },
    eventTitle: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
    eventWhen: {
      color: colors.textMuted,
      ...typography.caption,
    },
    eventRelative: {
      color: colors.warning,
      fontSize: 11,
      fontWeight: '600',
      marginTop: 1,
    },
    eventRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexShrink: 0,
    },

    // RSVP pill
    rsvpPill: {
      borderRadius: radius.pill,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    rsvpPillText: {
      fontSize: 12,
      fontWeight: '700',
    },
    rsvpPillGoing: { backgroundColor: withAlpha(colors.success, 0.18) },
    rsvpPillTextGoing: { color: colors.success },
    rsvpPillMaybe: { backgroundColor: withAlpha(colors.warning, 0.18) },
    rsvpPillTextMaybe: { color: colors.warning },
    rsvpPillNotGoing: { backgroundColor: withAlpha(colors.error, 0.18) },
    rsvpPillTextNotGoing: { color: colors.error },
    rsvpPillNone: {
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: 'transparent',
    },
    rsvpPillNoneText: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '700',
    },

    // Empty state
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 64,
      paddingHorizontal: spacing.xl,
    },
    emptyIcon: {
      marginBottom: spacing.md,
    },
    emptyTitle: {
      color: colors.text,
      ...typography.heading,
      marginBottom: spacing.sm,
      textAlign: 'center',
    },
    emptySubtitle: {
      color: colors.textMuted,
      ...typography.body,
      textAlign: 'center',
      lineHeight: 24,
    },
  });
}

type Styles = ReturnType<typeof createStyles>;

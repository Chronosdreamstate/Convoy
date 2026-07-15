import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  RefreshControl,
  SafeAreaView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { ThemeColors, useTheme } from '../theme';
import { apiClient } from '../services/apiClient';
import { offlineQueue, isOfflineError } from '../services/OfflineQueueService';
import SkeletonCard from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { useSocketStore } from '../stores/socketStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationType =
  | 'sos_alert'
  | 'friend_request'
  | 'group_invite'
  | 'group_event'
  | 'convoy_started'
  | 'event_reminder'
  | 'rally_point'
  | 'hazard_alert'
  | 'gap_alert'
  | 'fuel_suggest'
  | 'arriving_destination';

export interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
  createdAt: string;
  readAt: string | null;
}

interface NotificationSection {
  title: string;
  data: NotificationItem[];
}

type IconSpec =
  | { family: 'ion'; name: React.ComponentProps<typeof Ionicons>['name'] }
  | { family: 'mc'; name: React.ComponentProps<typeof MaterialCommunityIcons>['name'] };

function TypeIcon({ icon, color, size }: { icon: IconSpec; color: string; size: number }) {
  if (icon.family === 'mc') {
    return <MaterialCommunityIcons name={icon.name} size={size} color={color} />;
  }
  return <Ionicons name={icon.name} size={size} color={color} />;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'convoy:notifications';
const MAX_STORED = 50;

// Notification type icon + accent bubble color. Icon colors resolve from the
// theme so they adapt to light/dark; a couple (group/event purple) have no
// semantic theme token and stay as fixed accent hex values.
function buildTypeMeta(colors: ThemeColors): Record<NotificationType, { icon: IconSpec; bg: string }> {
  return {
    sos_alert:            { icon: { family: 'ion', name: 'alert-circle' }, bg: colors.accent },
    friend_request:       { icon: { family: 'ion', name: 'people' }, bg: colors.success },
    group_invite:         { icon: { family: 'ion', name: 'car' }, bg: colors.info },
    group_event:          { icon: { family: 'ion', name: 'calendar' }, bg: '#8B5CF6' },
    convoy_started:       { icon: { family: 'ion', name: 'flag' }, bg: colors.accent },
    event_reminder:       { icon: { family: 'ion', name: 'calendar' }, bg: '#8B5CF6' },
    rally_point:          { icon: { family: 'ion', name: 'location' }, bg: colors.success },
    hazard_alert:         { icon: { family: 'ion', name: 'warning' }, bg: colors.warning },
    gap_alert:            { icon: { family: 'ion', name: 'warning' }, bg: colors.warning },
    fuel_suggest:         { icon: { family: 'mc', name: 'gas-station' }, bg: colors.warning },
    arriving_destination: { icon: { family: 'ion', name: 'checkmark-circle' }, bg: colors.success },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 7) {
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });
  }
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Reconcile a fresh server page with local state. The server is the source of
 * truth for WHICH notifications exist, but local read-state is monotonic: a
 * notification the user already read on this device stays read even when the
 * server copy still says unread (the mark-read PATCH may be sitting in the
 * offline queue after a dead-zone tap). Without this, pull-to-refresh right
 * after reconnecting resurrected already-read rows as unread.
 * Exported for tests.
 */
export function mergeServerNotifications(
  local: NotificationItem[],
  fresh: NotificationItem[],
): NotificationItem[] {
  const localById = new Map(local.map((n) => [n.id, n]));
  return fresh.map((n) => {
    const prev = localById.get(n.id);
    return prev?.readAt && !n.readAt ? { ...n, readAt: prev.readAt } : n;
  });
}

function buildSections(items: NotificationItem[]): NotificationSection[] {
  const now = Date.now();
  const oneDayMs = 86400000;
  const oneWeekMs = 7 * oneDayMs;

  const today: NotificationItem[] = [];
  const thisWeek: NotificationItem[] = [];
  const earlier: NotificationItem[] = [];

  for (const n of items) {
    const age = now - new Date(n.createdAt).getTime();
    if (age < oneDayMs) today.push(n);
    else if (age < oneWeekMs) thisWeek.push(n);
    else earlier.push(n);
  }

  const sections: NotificationSection[] = [];
  if (today.length)    sections.push({ title: 'Today',     data: today });
  if (thisWeek.length) sections.push({ title: 'This Week', data: thisWeek });
  if (earlier.length)  sections.push({ title: 'Earlier',   data: earlier });
  return sections;
}

async function loadCached(): Promise<NotificationItem[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as NotificationItem[]) : [];
  } catch {
    return [];
  }
}

async function saveToCache(items: NotificationItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_STORED)));
  } catch {
    // intentionally empty — caching notifications locally is best-effort only
  }
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

interface RowProps {
  item: NotificationItem;
  onPress: (item: NotificationItem) => void;
  typeMeta: Record<NotificationType, { icon: IconSpec; bg: string }>;
  styles: Styles;
  colors: ThemeColors;
}

const NotificationRow = React.memo(function NotificationRow({ item, onPress, typeMeta, styles, colors }: RowProps) {
  const meta = typeMeta[item.type] ?? { icon: { family: 'ion' as const, name: 'notifications' as const }, bg: colors.card };
  const isUnread = item.readAt === null;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  function handlePressIn() {
    Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true, speed: 20 }).start();
  }
  function handlePressOut() {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 20 }).start();
  }

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[styles.row, isUnread && styles.rowUnread]}
        onPress={() => onPress(item)}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
        accessibilityRole="button"
        accessibilityLabel={item.title}
      >
        {isUnread && <View style={styles.unreadStripe} />}

        <View style={[styles.iconBubble, { backgroundColor: meta.bg }]}>
          <TypeIcon icon={meta.icon} color="#FFFFFF" size={20} />
        </View>

        <View style={styles.rowContent}>
          <Text style={[styles.rowTitle, isUnread && styles.rowTitleBold]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.rowBody} numberOfLines={2}>{item.body}</Text>
        </View>

        <Text style={styles.rowTime}>{timeAgo(item.createdAt)}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
});

// ---------------------------------------------------------------------------
// NotificationCenterScreen
// ---------------------------------------------------------------------------

export default function NotificationCenterScreen() {
  const { colors, spacing, radius, hitSlop } = useTheme();
  const styles = useMemo(() => createStyles(colors, spacing, radius), [colors, spacing, radius]);
  const typeMeta = useMemo(() => buildTypeMeta(colors), [colors]);

  const router = useRouter();
  const { socket } = useSocketStore();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const mergeAndSave = useCallback((incoming: NotificationItem[]) => {
    setNotifications((prev) => {
      const ids = new Set(prev.map((n) => n.id));
      const merged = [
        ...incoming.filter((n) => !ids.has(n.id)),
        ...prev,
      ].slice(0, MAX_STORED);
      void saveToCache(merged);
      return merged;
    });
  }, []);

  const fetchNotifications = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const cached = await loadCached();
    if (cached.length > 0) setNotifications(cached);

    try {
      const res = await apiClient.get<{ notifications: NotificationItem[] }>(
        '/api/v1/notifications?limit=50',
      );
      const fresh = res.data.notifications ?? [];
      setNotifications((prev) => {
        const merged = mergeServerNotifications(prev.length > 0 ? prev : cached, fresh);
        void saveToCache(merged);
        return merged;
      });
      setLoadError(false);
    } catch {
      // Degrade gracefully to cached data when there is any — but with no
      // cache either, falling through silently would render the exact same
      // "No notifications yet" empty state a genuinely fresh account sees,
      // hiding a real connectivity failure behind misleading copy.
      if (cached.length === 0) setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  // Socket-driven real-time notifications
  useEffect(() => {
    if (!socket) return;

    const handlers: Array<[string, (data: Record<string, unknown>) => void]> = [
      ['sos:received', (d) => mergeAndSave([{
        id: `sos-${Date.now()}`,
        type: 'sos_alert',
        title: `SOS from ${(d.callsign as string) ?? 'Unknown'}`,
        body: 'Member sent an emergency alert',
        data: { groupId: d.groupId as string },
        createdAt: new Date().toISOString(),
        readAt: null,
      }])],
      ['gap:alert', (d) => mergeAndSave([{
        id: `gap-${Date.now()}`,
        type: 'gap_alert',
        title: `${(d.callsign as string) ?? 'Someone'} fell behind`,
        body: `Gap detected in your convoy`,
        data: { groupId: d.groupId as string },
        createdAt: new Date().toISOString(),
        readAt: null,
      }])],
      ['friend:request', (d) => mergeAndSave([{
        id: `fr-${Date.now()}`,
        type: 'friend_request',
        title: `${(d.name as string) ?? 'Someone'} wants to connect`,
        body: 'Tap to accept or decline',
        data: { userId: d.userId as string },
        createdAt: new Date().toISOString(),
        readAt: null,
      }])],
      ['group:invite', (d) => mergeAndSave([{
        id: `gi-${Date.now()}`,
        type: 'group_invite',
        title: `Invited to ${(d.groupName as string) ?? 'a group'}`,
        body: 'Tap to view the invitation',
        data: { groupId: d.groupId as string },
        createdAt: new Date().toISOString(),
        readAt: null,
      }])],
      ['convoy:started', (d) => mergeAndSave([{
        id: `cs-${Date.now()}`,
        type: 'convoy_started',
        title: `Convoy started`,
        body: `${(d.groupName as string) ?? 'Your group'} is on the move`,
        data: { groupId: d.groupId as string },
        createdAt: new Date().toISOString(),
        readAt: null,
      }])],
    ];

    for (const [event, handler] of handlers) {
      socket.on(event, handler as (data: unknown) => void);
    }
    return () => {
      for (const [event, handler] of handlers) {
        socket.off(event, handler as (data: unknown) => void);
      }
    };
  }, [socket, mergeAndSave]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchNotifications(true);
  }, [fetchNotifications]);

  const handlePress = useCallback((item: NotificationItem) => {
    setNotifications((prev) => {
      const updated = prev.map((n) =>
        n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n,
      );
      // Persist read-state so it survives an app restart while offline.
      void saveToCache(updated);
      return updated;
    });
    // Mark read on the server; in a dead zone, queue the PATCH for replay so
    // the read-state isn't silently lost (dedupeKey — re-taps replace, not
    // stack). Socket-synthesized ids 404 server-side; a 404 has a response so
    // isOfflineError is false and nothing is queued for them.
    void apiClient.patch(`/api/v1/notifications/${item.id}/read`).catch(async (err) => {
      if (isOfflineError(err)) {
        await offlineQueue.enqueue({
          method: 'PATCH',
          url: `/api/v1/notifications/${item.id}/read`,
          body: undefined,
          headers: {},
          dedupeKey: `notif-read:${item.id}`,
        }).catch(() => {});
      }
    });

    const gid = item.data?.groupId;
    const eventId = item.data?.eventId;
    switch (item.type) {
      case 'sos_alert':
      case 'hazard_alert':
      case 'gap_alert':
      case 'fuel_suggest':
      case 'arriving_destination':
      case 'convoy_started':
        router.push('/(tabs)/map' as never);
        break;
      case 'friend_request':
        // Deep-link straight into the Requests tab — FriendsScreen reads this
        // via useLocalSearchParams<{ tab?: string }>() (see FriendsScreen.tsx).
        router.push('/friends?tab=requests' as never);
        break;
      case 'group_invite':
        // Join-request lifecycle items carry groupId — land on the group so
        // the tap is actionable; a joinCode prefills the code-entry screen.
        // Only with neither do we fall back to the bare join screen.
        if (item.data?.joinCode) {
          router.push({ pathname: '/join', params: { prefillCode: item.data.joinCode } } as never);
        } else if (gid) {
          router.push(`/group/${gid}` as never);
        } else {
          router.push('/join' as never);
        }
        break;
      case 'group_event':
      case 'event_reminder':
        // Server pushes stamp data with { groupId, eventId } (see
        // groups.routes.ts event create/remind) — land on the event itself so
        // the rider can RSVP in one tap instead of hunting through the group.
        if (eventId) {
          router.push({ pathname: '/event/[id]', params: { id: eventId, groupId: gid ?? '' } } as never);
        } else if (gid) {
          router.push(`/group/${gid}` as never);
        } else {
          router.push('/(tabs)/convoy' as never);
        }
        break;
      case 'rally_point':
        if (gid) router.push(`/group/${gid}` as never);
        else router.push('/(tabs)/convoy' as never);
        break;
    }
  }, [router]);

  const handleMarkAllRead = useCallback(() => {
    const now = new Date().toISOString();
    setNotifications((prev) => {
      const updated = prev.map((n) => ({ ...n, readAt: n.readAt ?? now }));
      void saveToCache(updated);
      void apiClient.patch('/api/v1/notifications/read-all').catch(async (err) => {
        // Same dead-zone handling as single mark-read: queue for replay.
        if (isOfflineError(err)) {
          await offlineQueue.enqueue({
            method: 'PATCH',
            url: '/api/v1/notifications/read-all',
            body: undefined,
            headers: {},
            dedupeKey: 'notif-read-all',
          }).catch(() => {});
        }
      });
      return updated;
    });
  }, []);

  const unreadCount = notifications.filter((n) => n.readAt === null).length;
  // Req 33 — while the vehicle is in motion, cap the list to 4 rows with a
  // "pull over to see more" notice (notifications are plausibly checked while
  // driving). Sections are built from the capped rows so the 4-row limit holds
  // across section boundaries; the full list returns the moment the car parks.
  const { data: visibleNotifications, hiddenCount } = useMotionCappedData(notifications);
  const sections = buildSections(visibleNotifications);

  const renderNotificationItem = useCallback(
    ({ item }: { item: NotificationItem }) => (
      <NotificationRow item={item} onPress={handlePress} typeMeta={typeMeta} styles={styles} colors={colors} />
    ),
    [handlePress, typeMeta, styles, colors],
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={hitSlop}
        >
          <Ionicons name="chevron-back" size={22} color={colors.accent} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Notifications</Text>
          {unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{unreadCount}</Text>
            </View>
          )}
        </View>

        {unreadCount > 0 ? (
          <TouchableOpacity
            style={styles.markAllBtn}
            onPress={handleMarkAllRead}
            hitSlop={hitSlop}
            accessibilityRole="button"
            accessibilityLabel="Mark all notifications as read"
          >
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.markAllBtn} />
        )}
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.skeletonList}>
          {[0, 1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </View>
      ) : loadError ? (
        <NetworkError
          onRetry={() => { setLoading(true); void fetchNotifications(); }}
          message="Could not load notifications. Please check your connection."
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderNotificationItem}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="notifications-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptySubtitle}>You'll see convoy alerts here</Text>
            </View>
          }
          ListFooterComponent={
            <View style={styles.capNoticeWrap}>
              <MotionCapNotice hiddenCount={hiddenCount} />
            </View>
          }
          contentContainerStyle={sections.length === 0 ? styles.emptyContainer : styles.listContent}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ThemeColors, spacing: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number }, radius: { sm: number; md: number; lg: number; xl: number; pill: number }) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backButton: {
      width: 60,
    },
    headerCenter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    headerTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    unreadBadge: {
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      minWidth: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    unreadBadgeText: {
      color: '#FFFFFF',
      fontSize: 11,
      fontWeight: '800',
    },
    markAllBtn: {
      width: 80,
      alignItems: 'flex-end',
    },
    markAllText: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '600',
    },
    skeletonList: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      gap: spacing.sm,
    },
    listContent: {
      paddingBottom: 40,
    },
    capNoticeWrap: {
      paddingHorizontal: spacing.md,
    },
    emptyContainer: {
      flex: 1,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 100,
      gap: spacing.sm,
    },
    emptyTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '700',
    },
    emptySubtitle: {
      color: colors.textMuted,
      fontSize: 14,
      textAlign: 'center',
      paddingHorizontal: 32,
    },
    sectionHeader: {
      paddingHorizontal: spacing.md,
      paddingTop: 20,
      paddingBottom: 8,
    },
    sectionTitle: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    separator: {
      height: 1,
      backgroundColor: colors.border,
      marginLeft: 72,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
      gap: spacing.sm,
    },
    rowUnread: {
      backgroundColor: 'rgba(220, 20, 60, 0.05)',
    },
    unreadStripe: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      backgroundColor: colors.accent,
      borderRadius: 2,
    },
    iconBubble: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    rowContent: {
      flex: 1,
      gap: 3,
    },
    rowTitle: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '500',
    },
    rowTitleBold: {
      fontWeight: '700',
    },
    rowBody: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
    },
    rowTime: {
      color: colors.textSubtle,
      fontSize: 12,
      flexShrink: 0,
    },
  });
}

type Styles = ReturnType<typeof createStyles>;

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { theme } from '../theme';
import { apiClient } from '../services/apiClient';
import SkeletonCard from '../components/SkeletonLoader';
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

interface NotificationItem {
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'convoy:notifications';
const MAX_STORED = 50;

const TYPE_META: Record<NotificationType, { icon: string; bg: string }> = {
  sos_alert:           { icon: '🆘', bg: '#DC143C' },
  friend_request:      { icon: '🤝', bg: '#22C55E' },
  group_invite:        { icon: '🚗', bg: '#3B82F6' },
  group_event:         { icon: '📅', bg: '#8B5CF6' },
  convoy_started:      { icon: '🏁', bg: '#DC143C' },
  event_reminder:      { icon: '📅', bg: '#8B5CF6' },
  rally_point:         { icon: '📍', bg: '#22C55E' },
  hazard_alert:        { icon: '⚠️', bg: '#F59E0B' },
  gap_alert:           { icon: '⚠️', bg: '#F59E0B' },
  fuel_suggest:        { icon: '⛽', bg: '#F59E0B' },
  arriving_destination:{ icon: '✅', bg: '#22C55E' },
};

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
  } catch {}
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

interface RowProps {
  item: NotificationItem;
  onPress: (item: NotificationItem) => void;
}

const NotificationRow = React.memo(function NotificationRow({ item, onPress }: RowProps) {
  const meta = TYPE_META[item.type] ?? { icon: '🔔', bg: theme.colors.card };
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
          <Text style={styles.iconText}>{meta.icon}</Text>
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
  const router = useRouter();
  const { socket } = useSocketStore();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
      setNotifications(fresh);
      void saveToCache(fresh);
    } catch {
      // Use cached data — already set above
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
        title: `🆘 SOS from ${(d.callsign as string) ?? 'Unknown'}`,
        body: 'Member sent an emergency alert',
        data: { groupId: d.groupId as string },
        createdAt: new Date().toISOString(),
        readAt: null,
      }])],
      ['gap:alert', (d) => mergeAndSave([{
        id: `gap-${Date.now()}`,
        type: 'gap_alert',
        title: `⚠️ ${(d.callsign as string) ?? 'Someone'} fell behind`,
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
        title: `🏁 Convoy started`,
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
    setNotifications((prev) =>
      prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)),
    );
    void apiClient.patch(`/api/v1/notifications/${item.id}/read`).catch(() => {});

    const gid = item.data?.groupId;
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
        router.push('/friends' as never);
        break;
      case 'group_invite':
        router.push('/join' as never);
        break;
      case 'group_event':
      case 'event_reminder':
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
      void apiClient.patch('/api/v1/notifications/read-all').catch(() => {});
      return updated;
    });
  }, []);

  const unreadCount = notifications.filter((n) => n.readAt === null).length;
  const sections = buildSections(notifications);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          hitSlop={theme.hitSlop}
        >
          <Text style={styles.backText}>‹ Back</Text>
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
            hitSlop={theme.hitSlop}
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
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={handlePress} />
          )}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>🔔</Text>
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptySubtitle}>You'll see convoy alerts here</Text>
            </View>
          }
          contentContainerStyle={sections.length === 0 ? styles.emptyContainer : styles.listContent}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.accent}
              colors={[theme.colors.accent]}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    width: 60,
  },
  backText: {
    color: theme.colors.accent,
    fontSize: 17,
    fontWeight: '600',
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  unreadBadge: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.pill,
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
    color: theme.colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  skeletonList: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  listContent: {
    paddingBottom: 40,
  },
  emptyContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
    gap: theme.spacing.sm,
  },
  emptyEmoji: {
    fontSize: 52,
    marginBottom: 8,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  emptySubtitle: {
    color: theme.colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  sectionHeader: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginLeft: 72,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 14,
    gap: theme.spacing.sm,
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
    backgroundColor: theme.colors.accent,
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
  iconText: {
    fontSize: 20,
  },
  rowContent: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '500',
  },
  rowTitleBold: {
    fontWeight: '700',
  },
  rowBody: {
    color: theme.colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  rowTime: {
    color: theme.colors.textSubtle,
    fontSize: 12,
    flexShrink: 0,
  },
});

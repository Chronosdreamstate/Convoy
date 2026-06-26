import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../theme';
import { apiClient } from '../services/apiClient';
import SkeletonCard from '../components/SkeletonLoader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationType =
  | 'sos_alert'
  | 'friend_request'
  | 'group_invite'
  | 'group_event'
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
  createdAt: string;
  readAt: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_ICON: Record<NotificationType, string> = {
  sos_alert: '🆘',
  friend_request: '👋',
  group_invite: '🚗',
  group_event: '📍',
  rally_point: '🏁',
  hazard_alert: '⚠️',
  gap_alert: '📏',
  fuel_suggest: '⛽',
  arriving_destination: '✅',
};

const TYPE_COLOR: Record<NotificationType, string> = {
  sos_alert: theme.colors.error,
  friend_request: theme.colors.info,
  group_invite: theme.colors.accent,
  group_event: theme.colors.success,
  rally_point: theme.colors.success,
  hazard_alert: theme.colors.warning,
  gap_alert: theme.colors.warning,
  fuel_suggest: theme.colors.warning,
  arriving_destination: theme.colors.success,
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

interface RowProps {
  item: NotificationItem;
  onPress: (item: NotificationItem) => void;
}

function NotificationRow({ item, onPress }: RowProps) {
  const icon = TYPE_ICON[item.type] ?? '🔔';
  const accentColor = TYPE_COLOR[item.type] ?? theme.colors.accent;
  const isUnread = item.readAt === null;

  return (
    <TouchableOpacity
      style={[styles.row, isUnread && styles.rowUnread]}
      onPress={() => onPress(item)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={item.title}
    >
      {/* Unread dot */}
      {isUnread && <View style={styles.unreadDot} />}

      {/* Icon bubble */}
      <View style={[styles.iconBubble, { borderColor: accentColor }]}>
        <Text style={styles.iconText}>{icon}</Text>
      </View>

      {/* Content */}
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.rowBody} numberOfLines={2}>{item.body}</Text>
      </View>

      {/* Time */}
      <Text style={styles.rowTime}>{timeAgo(item.createdAt)}</Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// NotificationCenterScreen
// ---------------------------------------------------------------------------

export default function NotificationCenterScreen() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchNotifications = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await apiClient.get<{ notifications: NotificationItem[] }>(
        '/api/v1/notifications?limit=50',
      );
      setNotifications(res.data.notifications ?? []);
    } catch {
      // Non-fatal — show cached data if available
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchNotifications(true);
  }, [fetchNotifications]);

  const handlePress = useCallback((item: NotificationItem) => {
    // Mark as read optimistically
    setNotifications((prev) =>
      prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)),
    );
    void apiClient.post(`/api/v1/notifications/${item.id}/read`).catch(() => {});

    // Navigate based on type
    switch (item.type) {
      case 'sos_alert':
      case 'hazard_alert':
      case 'gap_alert':
      case 'fuel_suggest':
      case 'arriving_destination':
        router.push('/(tabs)/map' as never);
        break;
      case 'friend_request':
        router.push('/friends' as never);
        break;
      case 'group_invite':
        router.push('/join' as never);
        break;
      case 'group_event':
      case 'rally_point':
        router.push('/(tabs)/convoy' as never);
        break;
    }
  }, [router]);

  const unreadCount = notifications.filter((n) => n.readAt === null).length;

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
        <View style={styles.backButton} />
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.skeletonList}>
          {[0, 1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <NotificationRow item={item} onPress={handlePress} />
          )}
          contentContainerStyle={
            notifications.length === 0 ? styles.emptyContainer : styles.listContent
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>🔔</Text>
              <Text style={styles.emptyTitle}>All caught up</Text>
              <Text style={styles.emptySubtitle}>No notifications yet</Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
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
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  skeletonList: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  listContent: {
    paddingBottom: theme.spacing.xl,
  },
  emptyContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyEmoji: {
    fontSize: 52,
    marginBottom: theme.spacing.md,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  emptySubtitle: {
    color: theme.colors.textMuted,
    fontSize: 14,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  rowUnread: {
    backgroundColor: 'rgba(220, 20, 60, 0.04)',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.accent,
    position: 'absolute',
    left: 6,
    top: '50%',
  },
  iconBubble: {
    width: 44,
    height: 44,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
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
    fontWeight: '600',
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

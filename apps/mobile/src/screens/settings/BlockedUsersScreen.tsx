/**
 * BlockedUsersScreen — self-service list + unblock for users the current
 * user has blocked (Req 17.11). Blocking exists in several places
 * (FriendsScreen, UserProfileScreen, GroupChatScreen) but there was
 * previously no way to see or reverse a block — this closes that gap.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { apiClient } from '../../services/apiClient';
import { SkeletonRow } from '../../components/SkeletonLoader';
import { ThemeColors, useTheme } from '../../theme';

interface BlockedUser {
  id: string; // friendship id
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  callsign?: string | null;
}

// Text that always sits on the crimson accent fill — stays light in both themes.
const ON_ACCENT = '#FFFFFF';

const AVATAR_COLORS = ['#DC143C', '#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#14B8A6'];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

export default function BlockedUsersScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get<{ blocked: BlockedUser[] }>('/api/v1/friends/blocked');
      // ?? [] — a 200 without the key would otherwise blow up in render on
      // `blocked.length` rather than showing the empty state.
      setBlocked(data.blocked ?? []);
    } catch {
      setError('Failed to load blocked users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const handleUnblock = useCallback((user: BlockedUser) => {
    Alert.alert(
      'Unblock User',
      `${user.displayName} will be able to send you friend requests and interact with you again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: async () => {
            setUnblockingId(user.id);
            try {
              await apiClient.post('/api/v1/friends/unblock', { userId: user.userId });
              setBlocked((prev) => prev.filter((u) => u.id !== user.id));
            } catch {
              setError('Could not unblock this user. Please try again.');
            } finally {
              setUnblockingId(null);
            }
          },
        },
      ],
    );
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Blocked Users</Text>
        <View style={styles.placeholder} />
      </View>

      {loading ? (
        <View style={styles.skeletonWrap}>
          {[0, 1].map((i) => <SkeletonRow key={i} />)}
        </View>
      ) : error && blocked.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="alert-circle-outline" size={44} color={colors.textMuted} style={styles.emptyIcon} />
          <Text style={styles.emptyTitle}>Couldn't load blocked users</Text>
          <Text style={styles.emptySub}>{error}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => void load()}
            accessibilityRole="button"
            accessibilityLabel="Retry loading blocked users"
          >
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : blocked.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="ban-outline" size={44} color={colors.textMuted} style={styles.emptyIcon} />
          <Text style={styles.emptyTitle}>No blocked users</Text>
          <Text style={styles.emptySub}>Users you block will appear here so you can unblock them later.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {error ? <Text style={styles.errorTxt}>{error}</Text> : null}
          {blocked.map((user) => (
            <View key={user.id} style={styles.row}>
              <View style={[styles.avatar, { backgroundColor: avatarColor(user.displayName) }]}>
                <Text style={styles.avatarText}>{initials(user.displayName)}</Text>
              </View>
              <View style={styles.rowInfo}>
                <Text style={styles.rowName} numberOfLines={1}>{user.displayName}</Text>
                {user.callsign ? <Text style={styles.rowSub} numberOfLines={1}>{user.callsign}</Text> : null}
              </View>
              <TouchableOpacity
                style={styles.unblockBtn}
                onPress={() => handleUnblock(user)}
                disabled={unblockingId === user.id}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={`Unblock ${user.displayName}`}
                accessibilityState={{ disabled: unblockingId === user.id, busy: unblockingId === user.id }}
              >
                {unblockingId === user.id ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <Text style={styles.unblockBtnText}>Unblock</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    back: { width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
    title: { fontSize: 17, fontWeight: '600', color: colors.text },
    placeholder: { width: 44 },
    skeletonWrap: { padding: 16 },
    list: { padding: 16 },
    errorTxt: { color: colors.error, fontSize: 13, marginBottom: 12 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 12,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    avatarText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
    rowInfo: { flex: 1 },
    rowName: { fontSize: 15, fontWeight: '600', color: colors.text },
    rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    unblockBtn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.accent,
    },
    unblockBtnText: { fontSize: 13, fontWeight: '600', color: colors.accent },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    emptyIcon: { marginBottom: 12 },
    emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 6 },
    emptySub: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
    retryBtn: {
      marginTop: 20,
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 24,
      paddingVertical: 12,
      minHeight: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    retryBtnText: { color: ON_ACCENT, fontSize: 15, fontWeight: '700' },
  });
}

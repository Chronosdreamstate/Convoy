import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { ThemeColors, useTheme } from '../theme';

const STORAGE_KEY = 'convoy:recent_searches';
const MAX_RECENT = 5;

// Text that always sits on the crimson accent fill (retry button) — stays
// light in both themes. `colors.text` is near-black in light mode, which
// would be unreadable on the accent background.
const ON_ACCENT = '#FFFFFF';

interface Group {
  id: string;
  name: string;
  memberCount: number;
  accessType: 'open' | 'invite_only';
  nextEvent?: { title: string; scheduledFor: string } | null;
}

interface UserResult {
  id: string;
  displayName: string;
  pttCallsign?: string;
  isOnline?: boolean;
  friendStatus?: 'none' | 'pending' | 'friends';
}

// Avatar colors — deterministic per name. Intentionally a fixed decorative
// palette (not theme chrome) so a given user's initials bubble looks the
// same regardless of light/dark mode.
function avatarColor(name: string): string {
  const colors = ['#DC143C', '#3B82F6', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'groups' | 'people'>('groups');
  const [groups, setGroups] = useState<Group[]>([]);
  const [people, setPeople] = useState<UserResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [friendActions, setFriendActions] = useState<Partial<Record<string, 'pending' | 'friends'>>>({});
  // Tracks in-flight join/add-friend requests by id so a rapid double-tap
  // can't fire the same request twice while the first is still pending.
  const [submittingIds, setSubmittingIds] = useState<Set<string>>(new Set());
  // Groups where a join *request* (invite-only) has been sent and is awaiting
  // admin approval — distinct from `groups` state since it doesn't change
  // membership, just shows a "Requested" pill instead of "Request".
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => { if (raw) setRecentSearches(JSON.parse(raw) as string[]); })
      .catch(() => {});
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => {
      clearTimeout(focusTimer);
      // Leaving mid-keystroke otherwise fires one more search 300 ms later,
      // against a screen that no longer exists.
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const saveRecent = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecentSearches((prev) => {
      const next = [trimmed, ...prev.filter((s) => s !== trimmed)].slice(0, MAX_RECENT);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setGroups([]); setPeople([]); setError(null); return; }
    setLoading(true);
    setError(null);
    try {
      if (activeTab === 'groups') {
        const res = await apiClient.get<{ groups: Group[] }>(`/api/v1/groups?q=${encodeURIComponent(q)}`);
        setGroups(res.data.groups ?? []);
      } else {
        const res = await apiClient.get<{ users: UserResult[] }>(`/api/v1/users/search?q=${encodeURIComponent(q)}`);
        setPeople(res.data.users ?? []);
      }
      saveRecent(q);
    } catch {
      setError('Search failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [activeTab, saveRecent]);

  const handleQueryChange = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(text), 300);
  };

  useEffect(() => {
    if (query.trim()) search(query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleJoinGroup = useCallback(async (group: Group) => {
    const { id: groupId, accessType } = group;
    if (submittingIds.has(groupId) || requestedIds.has(groupId)) return;
    setSubmittingIds((prev) => new Set(prev).add(groupId));

    // Invite-only groups have no direct-join route — send an admin-approval
    // request instead and just flip the button to "Requested" in place.
    if (accessType === 'invite_only') {
      try {
        await apiClient.post(`/api/v1/groups/${groupId}/join-request`, {});
        setRequestedIds((prev) => new Set(prev).add(groupId));
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        if (status === 409) {
          // Already a member, or already has a pending request — either way
          // there's nothing more for this tap to do.
          setRequestedIds((prev) => new Set(prev).add(groupId));
        } else {
          Alert.alert('Could not send request', 'Please try again in a moment.');
        }
      } finally {
        setSubmittingIds((prev) => { const next = new Set(prev); next.delete(groupId); return next; });
      }
      return;
    }

    try {
      await apiClient.post(`/api/v1/groups/${groupId}/members`, {});
      router.push(`/group/${groupId}` as never);
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        // Already a member — the join is effectively done, go to the group.
        router.push(`/group/${groupId}` as never);
      } else {
        // A real failure (offline, group ended/expired) must not silently
        // dump the user on the group screen as if the join worked.
        Alert.alert(
          'Could not join',
          status === 410
            ? 'This group is no longer accepting new members.'
            : 'Please check your connection and try again.',
        );
      }
    } finally {
      setSubmittingIds((prev) => { const next = new Set(prev); next.delete(groupId); return next; });
    }
  }, [submittingIds, requestedIds, router]);

  const handleAddFriend = useCallback(async (userId: string) => {
    if (submittingIds.has(userId)) return;
    setSubmittingIds((prev) => new Set(prev).add(userId));
    try {
      await apiClient.post('/api/v1/friends/requests', { addresseeId: userId });
      setFriendActions((prev) => ({ ...prev, [userId]: 'pending' }));
    } catch {
      Alert.alert('Error', 'Could not send friend request. Please try again.');
    } finally {
      setSubmittingIds((prev) => { const next = new Set(prev); next.delete(userId); return next; });
    }
  }, [submittingIds]);

  const renderGroup = useCallback(({ item }: { item: Group }) => (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.cardLeft}
        onPress={() => router.push(`/group/${item.id}` as never)}
        accessibilityRole="button"
        accessibilityLabel={`View ${item.name} details`}
      >
        <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
        <View style={styles.pillRow}>
          <View style={styles.pill}>
            <Text style={styles.pillText}>{item.memberCount} members</Text>
          </View>
          <View style={[styles.pill, item.accessType === 'open' ? styles.pillGreen : styles.pillMuted]}>
            <Text style={styles.pillText}>{item.accessType === 'open' ? 'Public' : 'Invite'}</Text>
          </View>
          {item.nextEvent && (
            <View style={[styles.pill, styles.pillAmber, styles.pillWithIcon]}>
              <Ionicons name="calendar-outline" size={11} color={colors.textMuted} />
              <Text style={styles.pillText}>
                {new Date(item.nextEvent.scheduledFor).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
      {requestedIds.has(item.id) ? (
        <View style={[styles.actionBtn, styles.actionBtnMuted]}>
          <Text style={[styles.actionBtnText, styles.actionBtnTextMuted]}>Requested</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => { void handleJoinGroup(item); }}
          disabled={submittingIds.has(item.id)}
          accessibilityRole="button"
          accessibilityLabel={item.accessType === 'open' ? `Join ${item.name}` : `Request to join ${item.name}`}
        >
          {submittingIds.has(item.id) ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : (
            <Text style={styles.actionBtnText}>{item.accessType === 'open' ? 'Join' : 'Request'}</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  ), [handleJoinGroup, submittingIds, requestedIds, colors, styles, router]);

  const renderPerson = useCallback(({ item }: { item: UserResult }) => {
    const status = friendActions[item.id] ?? item.friendStatus ?? 'none';
    const initial = (item.displayName?.[0] ?? '?').toUpperCase();
    const isSubmitting = submittingIds.has(item.id);
    return (
      <View style={styles.card}>
        <View style={[styles.avatar, { backgroundColor: avatarColor(item.displayName) }]}>
          <Text style={styles.avatarText}>{initial}</Text>
          {item.isOnline && <View style={styles.onlineDot} />}
        </View>
        <TouchableOpacity
          style={styles.cardLeft}
          onPress={() => router.push(`/profile/${item.id}` as never)}
          accessibilityRole="button"
          accessibilityLabel={`View ${item.displayName}'s profile`}
        >
          <Text style={styles.cardName}>{item.displayName}</Text>
          {item.pttCallsign ? <Text style={styles.muted}>{item.pttCallsign}</Text> : null}
        </TouchableOpacity>
        {status === 'none' && (
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => { void handleAddFriend(item.id); }}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel={`Add ${item.displayName} as a friend`}
          >
            {isSubmitting ? (
              <ActivityIndicator color={colors.accent} size="small" />
            ) : (
              <Text style={styles.actionBtnText}>Add</Text>
            )}
          </TouchableOpacity>
        )}
        {status === 'pending' && (
          <View style={[styles.actionBtn, styles.actionBtnMuted]}>
            <Text style={[styles.actionBtnText, styles.actionBtnTextMuted]}>Pending</Text>
          </View>
        )}
        {status === 'friends' && (
          <View style={[styles.actionBtn, styles.actionBtnMuted]}>
            <Text style={[styles.actionBtnText, styles.actionBtnTextSuccess]}>Friends</Text>
          </View>
        )}
      </View>
    );
  }, [friendActions, handleAddFriend, submittingIds, colors, styles, router]);

  // Req 33 — cap the visible results to 4 rows while the vehicle is in motion
  // (see MotionAwareList). Groups and people live on separate tabs and never
  // render together, so capping each list independently still shows at most 4
  // rows on screen — unlike FriendsScreen's requests view, which combines its
  // two sections before capping because both render at once.
  const { data: visibleGroups, hiddenCount: hiddenGroupCount } = useMotionCappedData(groups);
  const { data: visiblePeople, hiddenCount: hiddenPeopleCount } = useMotionCappedData(people);

  const showRecent = !query.trim() && recentSearches.length > 0;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { paddingTop: insets.top }]}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.inputWrap}>
          <Ionicons name="search" size={16} color={colors.textMuted} style={styles.searchIcon} />
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder="Search groups, people..."
            placeholderTextColor={colors.textSubtle}
            value={query}
            onChangeText={handleQueryChange}
            returnKeyType="search"
            onSubmitEditing={() => search(query)}
            clearButtonMode="while-editing"
            accessibilityLabel="Search groups and people"
          />
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {(['groups', 'people'] as const).map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
            accessibilityRole="tab"
            accessibilityLabel={tab === 'groups' ? 'Groups' : 'People'}
            accessibilityState={{ selected: activeTab === tab }}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'groups' ? 'Groups' : 'People'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Recent searches */}
      {showRecent && (
        <View style={styles.recentSection}>
          <Text style={styles.sectionLabel}>RECENT</Text>
          {recentSearches.map((s) => (
            <TouchableOpacity
              key={s}
              style={styles.recentRow}
              onPress={() => { setQuery(s); search(s); }}
              accessibilityRole="button"
              accessibilityLabel={`Search for ${s}`}
            >
              <Ionicons name="time-outline" size={16} color={colors.textMuted} />
              <Text style={styles.recentText}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Results */}
      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loadingIndicator} />
      ) : query.trim() ? (
        error ? (
          <View style={styles.errorWrap}>
            <Ionicons name="alert-circle-outline" size={32} color={colors.textMuted} />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => void search(query)}
              accessibilityRole="button"
              accessibilityLabel="Retry search"
            >
              <Text style={styles.retryBtnText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        ) : activeTab === 'groups' ? (
          <FlatList
            data={visibleGroups}
            keyExtractor={(g) => g.id}
            renderItem={renderGroup}
            contentContainerStyle={styles.list}
            ListFooterComponent={<MotionCapNotice hiddenCount={hiddenGroupCount} />}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No groups found for "{query}"</Text>
            }
          />
        ) : (
          <FlatList
            data={visiblePeople}
            keyExtractor={(p) => p.id}
            renderItem={renderPerson}
            contentContainerStyle={styles.list}
            ListFooterComponent={<MotionCapNotice hiddenCount={hiddenPeopleCount} />}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No users found for "{query}"</Text>
            }
          />
        )
      ) : null}
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
    backBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    inputWrap: {
      flex: 1, flexDirection: 'row', alignItems: 'center',
      backgroundColor: colors.card, borderRadius: 12, paddingHorizontal: 12, height: 48,
      borderWidth: 1, borderColor: colors.border,
    },
    searchIcon: { marginRight: 8 },
    input: { flex: 1, color: colors.text, fontSize: 16 },
    tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
    tab: { flex: 1, paddingVertical: 12, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
    tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
    tabText: { fontSize: 15, color: colors.textMuted },
    tabTextActive: { color: colors.text, fontWeight: '600' },
    list: { padding: 12, gap: 8 },
    card: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 12, padding: 14,
      borderWidth: 1, borderColor: colors.border,
    },
    cardLeft: { flex: 1 },
    cardName: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
    pill: { backgroundColor: colors.cardElevated, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
    pillWithIcon: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    pillGreen: { backgroundColor: 'rgba(34,197,94,0.15)' },
    pillAmber: { backgroundColor: 'rgba(245,158,11,0.15)' },
    pillMuted: { backgroundColor: colors.cardElevated },
    pillText: { fontSize: 11, color: colors.textMuted },
    actionBtn: {
      borderWidth: 1, borderColor: colors.accent, borderRadius: 8,
      paddingHorizontal: 14, paddingVertical: 8, minWidth: 44, minHeight: 36,
      alignItems: 'center', justifyContent: 'center',
    },
    actionBtnMuted: { borderColor: colors.border },
    actionBtnText: { fontSize: 13, fontWeight: '600', color: colors.accent },
    actionBtnTextMuted: { color: colors.textMuted },
    actionBtnTextSuccess: { color: colors.success },
    avatar: {
      width: 44, height: 44, borderRadius: 22,
      alignItems: 'center', justifyContent: 'center',
    },
    avatarText: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
    onlineDot: {
      position: 'absolute', bottom: 1, right: 1,
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: colors.success, borderWidth: 1.5, borderColor: colors.card,
    },
    muted: { fontSize: 12, color: colors.textMuted },
    recentSection: { padding: 16 },
    sectionLabel: { fontSize: 11, color: colors.textSubtle, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
    recentRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10, minHeight: 44 },
    recentText: { fontSize: 15, color: colors.text },
    emptyText: { textAlign: 'center', color: colors.textSubtle, fontSize: 14, marginTop: 40 },
    loadingIndicator: { marginTop: 32 },
    errorWrap: { alignItems: 'center', paddingTop: 48, paddingHorizontal: 32, gap: 10 },
    errorText: { color: colors.textMuted, fontSize: 14, textAlign: 'center' },
    retryBtn: {
      marginTop: 10, backgroundColor: colors.accent, borderRadius: 10,
      paddingHorizontal: 20, paddingVertical: 10, minHeight: 44,
      alignItems: 'center', justifyContent: 'center',
    },
    retryBtnText: { color: ON_ACCENT, fontSize: 14, fontWeight: '700' },
  });
}

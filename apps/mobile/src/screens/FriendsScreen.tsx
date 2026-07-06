import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  RefreshControl,
  SectionList,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { SkeletonRow } from '../components/SkeletonLoader';
import { useGroupStore } from '../stores/groupStore';
import { useTheme, ThemeColors } from '../theme';

// Types
interface Friend {
  id: string;
  userId: string;
  displayName: string;
  callsign?: string;
  avatarUrl?: string;
  isOnline?: boolean;
}
interface FriendRequest {
  id: string;
  displayName: string;
  callsign?: string;
  mutualCount?: number;
}
interface SearchUser {
  id: string;
  displayName: string;
  callsign?: string;
  isFriend?: boolean;
  requestSent?: boolean;
}
type Tab = 'friends' | 'requests';
interface Section { title: string; data: Friend[] }

// Avatar colors — deterministic per name. Intentionally a fixed decorative
// palette (not theme chrome) so a given user's initials bubble looks the
// same regardless of light/dark mode.
const AVATAR_COLORS = ['#DC143C', '#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#14B8A6'];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
}

function Avatar({ name, online }: { name: string; online?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.avatarWrap}>
      <View style={[styles.avatar, { backgroundColor: avatarColor(name) }]}>
        <Text style={styles.avatarText}>{initials(name)}</Text>
      </View>
      {online && <View style={styles.onlineDot} />}
    </View>
  );
}

function Empty({ icon, title, sub }: { icon: keyof typeof Ionicons.glyphMap; title: string; sub: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={44} color={colors.textMuted} style={styles.emptyIcon} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySub}>{sub}</Text>
    </View>
  );
}

// Full error state with an explicit retry control — used when a list fails to
// load and there's nothing to show behind an inline banner.
function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.empty}>
      <Ionicons name="cloud-offline-outline" size={44} color={colors.textMuted} style={styles.emptyIcon} />
      <Text style={styles.emptyTitle}>Something went wrong</Text>
      <Text style={styles.emptySub}>{message}</Text>
      <TouchableOpacity
        style={styles.retryBtn}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Try again"
      >
        <Ionicons name="refresh" size={16} color={colors.text} style={styles.retryIcon} />
        <Text style={styles.retryBtnTxt}>Try Again</Text>
      </TouchableOpacity>
    </View>
  );
}

// Friend row with slide-out animation
function FriendRow({
  friend,
  onRemove,
  removing,
  onBlock,
  blocking,
}: {
  friend: Friend;
  onRemove: (id: string) => void;
  removing: boolean;
  onBlock: (id: string, userId: string) => void;
  blocking: boolean;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const slideAnim = useRef(new Animated.Value(0)).current;
  const opAnim = useRef(new Animated.Value(1)).current;

  const handleRemove = () => {
    Alert.alert('Remove Friend', `Remove ${friend.displayName} from your friends?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: () => {
          Animated.parallel([
            Animated.timing(slideAnim, { toValue: -80, duration: 250, useNativeDriver: true }),
            Animated.timing(opAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
          ]).start(() => onRemove(friend.id));
        },
      },
    ]);
  };

  const handleBlock = () => {
    Alert.alert(
      'Block User',
      `Block ${friend.displayName}? They won't be able to send you friend requests or see your location, and they'll be removed from your friends list.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block', style: 'destructive', onPress: () => {
            Animated.parallel([
              Animated.timing(slideAnim, { toValue: -80, duration: 250, useNativeDriver: true }),
              Animated.timing(opAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
            ]).start(() => onBlock(friend.id, friend.userId));
          },
        },
      ],
    );
  };

  const handleInviteToConvoy = async () => {
    if (!activeGroupId) return;
    try {
      const res = await apiClient.get<{ code: string; link: string }>(
        `/api/v1/groups/${activeGroupId}/invite-link`,
      );
      await Share.share({ message: `Join my convoy on CORTEGE! Code: ${res.data.code}\n${res.data.link}` });
    } catch {
      Alert.alert('Error', 'Could not get invite link.');
    }
  };

  const handleOpenDM = async () => {
    try {
      const res = await apiClient.post<{ groupId: string }>('/api/v1/dm', { friendId: friend.id });
      (router.push as (href: { pathname: string; params?: Record<string, string> }) => void)({ pathname: '/group-chat', params: { groupId: res.data.groupId } });
    } catch {
      Alert.alert('Error', 'Could not open message thread.');
    }
  };

  // View this friend on the map (Req 70) — IdleMapScreen reads `focusFriendId`
  // and, once its friend-locations poll resolves, centers on this friend's pin
  // if they're currently sharing, or lets the user know if they're not.
  const handleViewOnMap = () => {
    (router.push as (href: { pathname: string; params?: Record<string, string> }) => void)({
      pathname: '/(tabs)/map',
      params: { focusFriendId: friend.userId, focusFriendName: friend.displayName },
    });
  };

  const handleTap = () => {
    // Native Alert buttons render as plain OS text — they cannot host a
    // custom vector icon, so these emoji stay as lightweight visual
    // shorthand within the dialog copy itself.
    const buttons: Array<{ text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }> = [
      { text: '💬 Message', onPress: () => void handleOpenDM() },
    ];
    if (activeGroupId) buttons.push({ text: '📨 Invite to Convoy', onPress: () => void handleInviteToConvoy() });
    buttons.push({ text: '🚫 Remove', style: 'destructive', onPress: handleRemove });
    buttons.push({ text: '⛔ Block', style: 'destructive', onPress: handleBlock });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(friend.displayName, friend.callsign ? `📻 ${friend.callsign}` : undefined, buttons);
  };

  const busy = removing || blocking;

  return (
    <TouchableOpacity onPress={handleTap} activeOpacity={0.85} disabled={busy}>
    <Animated.View style={[styles.card, { transform: [{ translateX: slideAnim }], opacity: opAnim }]}>
      <Avatar name={friend.displayName} online={friend.isOnline} />
      <View style={styles.cardInfo}>
        <Text style={styles.cardName} numberOfLines={1}>{friend.displayName}</Text>
        {friend.callsign
          ? <Text style={styles.cardSub} numberOfLines={1}>{friend.callsign}</Text>
          : null}
      </View>
      <View style={styles.cardBtns}>
        <TouchableOpacity
          style={styles.mapBtn}
          onPress={handleViewOnMap}
          accessibilityRole="button"
          accessibilityLabel={`View ${friend.displayName} on map`}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Ionicons name="map-outline" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.trashBtn}
          onPress={handleRemove}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${friend.displayName}`}
          accessibilityState={{ disabled: busy }}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          {removing
            ? <ActivityIndicator color={colors.accent} size="small" />
            : <Ionicons name="person-remove-outline" size={17} color={colors.accent} />}
        </TouchableOpacity>
      </View>
    </Animated.View>
    </TouchableOpacity>
  );
}

// Friends tab with SectionList
function FriendsTab({ query }: { query: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data } = await apiClient.get<{ friends: Friend[] }>('/api/v1/friends');
      setFriends(data.friends);
    } catch { setError('Failed to load friends.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const handleRemove = useCallback(async (id: string) => {
    setRemoving(id);
    try {
      await apiClient.delete(`/api/v1/friends/${id}`);
      setFriends(p => p.filter(f => f.id !== id));
    } catch { setError('Could not remove friend.'); }
    finally { setRemoving(null); }
  }, []);

  const handleBlock = useCallback(async (id: string, userId: string) => {
    setBlocking(id);
    try {
      await apiClient.post('/api/v1/friends/block', { userId });
      setFriends(p => p.filter(f => f.id !== id));
    } catch { setError('Could not block user.'); }
    finally { setBlocking(null); }
  }, []);

  const renderFriendItem = useCallback(({ item }: { item: Friend }) => (
    <FriendRow
      friend={item}
      onRemove={handleRemove}
      removing={removing === item.id}
      onBlock={handleBlock}
      blocking={blocking === item.id}
    />
  ), [handleRemove, removing, handleBlock, blocking]);

  const q = query.toLowerCase().trim();
  const filtered = q
    ? friends.filter(f =>
        f.displayName.toLowerCase().includes(q) ||
        f.callsign?.toLowerCase().includes(q))
    : friends;

  if (loading) {
    return <View style={styles.skeletonWrap}>{[0, 1, 2, 3].map(i => <SkeletonRow key={i} />)}</View>;
  }

  // Load failed with nothing to show — full error state with a retry control.
  if (error && friends.length === 0) {
    return <ListError message={error} onRetry={() => void load()} />;
  }

  if (filtered.length === 0 && !error) {
    return q
      ? <Empty icon="search-outline" title="No matches" sub={`No friends match "${query.trim()}".`} />
      : <Empty icon="people-outline" title="No friends yet" sub="Use the + button to invite your crew." />;
  }

  const online = filtered.filter(f => f.isOnline);
  const offline = filtered.filter(f => !f.isOnline).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const sections: Section[] = [];
  if (online.length > 0) sections.push({ title: 'Online Now', data: online });
  if (offline.length > 0) sections.push({ title: 'Friends', data: offline });

  return (
    <SectionList
      sections={sections}
      keyExtractor={item => item.id}
      contentContainerStyle={styles.listPad}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
      }
      ListHeaderComponent={error ? <Text style={styles.errorTxt}>{error}</Text> : null}
      renderSectionHeader={({ section }) => (
        <Text style={styles.sectionHeader}>{section.title}</Text>
      )}
      renderItem={renderFriendItem}
      renderSectionFooter={({ section }) =>
        section.title === 'Online Now' && offline.length > 0 ? (
          <Text style={styles.onlineEmpty}>None of your other friends are driving right now</Text>
        ) : null
      }
    />
  );
}

// Request row with animated slide-out on accept
function RequestRow({
  req,
  onAct,
  acting,
}: {
  req: FriendRequest;
  onAct: (id: string, action: 'accept' | 'decline') => void;
  acting: { id: string; action: 'accept' | 'decline' } | null;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const slideAnim = useRef(new Animated.Value(0)).current;
  const opAnim = useRef(new Animated.Value(1)).current;
  const isMe = acting?.id === req.id;

  const handleAccept = () => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: 80, duration: 280, useNativeDriver: true }),
      Animated.timing(opAnim, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]).start(() => onAct(req.id, 'accept'));
  };

  const handleDecline = () => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: -80, duration: 220, useNativeDriver: true }),
      Animated.timing(opAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => onAct(req.id, 'decline'));
  };

  return (
    <Animated.View style={[styles.card, { transform: [{ translateX: slideAnim }], opacity: opAnim }]}>
      <Avatar name={req.displayName} />
      <View style={styles.cardInfo}>
        <Text style={styles.cardName} numberOfLines={1}>{req.displayName}</Text>
        <Text style={styles.cardSub}>
          {req.callsign ? `${req.callsign} · ` : ''}Wants to connect
        </Text>
        {req.mutualCount
          ? <Text style={styles.mutualTxt}>{req.mutualCount} mutual connection{req.mutualCount !== 1 ? 's' : ''}</Text>
          : null}
      </View>
      <View style={styles.cardBtns}>
        <TouchableOpacity
          style={styles.acceptBtn}
          onPress={handleAccept}
          disabled={!!isMe}
          accessibilityRole="button"
          accessibilityLabel={`Accept ${req.displayName}`}
          accessibilityState={{ disabled: !!isMe }}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          {isMe && acting?.action === 'accept'
            ? <ActivityIndicator color={colors.text} size="small" />
            : <Ionicons name="checkmark" size={20} color={colors.text} />}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.declineBtn}
          onPress={handleDecline}
          disabled={!!isMe}
          accessibilityRole="button"
          accessibilityLabel={`Decline ${req.displayName}`}
          accessibilityState={{ disabled: !!isMe }}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          {isMe && acting?.action === 'decline'
            ? <ActivityIndicator color={colors.textMuted} size="small" />
            : <Ionicons name="close" size={18} color={colors.textMuted} />}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// Requests tab
function RequestsTab({ onCount }: { onCount: (n: number) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [reqs, setReqs] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<{ id: string; action: 'accept' | 'decline' } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data } = await apiClient.get<{ requests: FriendRequest[] }>('/api/v1/friends/requests');
      setReqs(data.requests);
    } catch { setError('Failed to load requests.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onCount(reqs.length); }, [reqs.length, onCount]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const act = useCallback(async (id: string, action: 'accept' | 'decline') => {
    setActing({ id, action });
    try {
      await apiClient.post(`/api/v1/friends/requests/${id}/${action}`);
      setReqs(p => p.filter(r => r.id !== id));
    } catch { setError(`Failed to ${action} request.`); }
    finally { setActing(null); }
  }, []);

  const renderRequestItem = useCallback(({ item }: { item: FriendRequest }) => (
    <RequestRow req={item} onAct={act} acting={acting} />
  ), [act, acting]);

  if (loading) {
    return <View style={styles.skeletonWrap}>{[0, 1, 2].map(i => <SkeletonRow key={i} />)}</View>;
  }

  // Load failed with nothing to show — full error state with a retry control.
  if (error && reqs.length === 0) {
    return <ListError message={error} onRetry={() => void load()} />;
  }

  return (
    <SectionList
      sections={reqs.length > 0 ? [{ title: 'Pending', data: reqs }] : []}
      keyExtractor={item => item.id}
      contentContainerStyle={styles.listPad}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
      }
      ListHeaderComponent={error ? <Text style={styles.errorTxt}>{error}</Text> : null}
      ListEmptyComponent={
        !error ? <Empty icon="mail-unread-outline" title="No pending requests" sub="When someone adds you, they'll appear here." /> : null
      }
      renderSectionHeader={({ section }) => (
        <Text style={styles.sectionHeader}>{section.title} ({section.data.length})</Text>
      )}
      renderItem={renderRequestItem}
    />
  );
}

// User search dropdown
function UserSearchResults({
  results,
  onAdd,
  adding,
}: {
  results: SearchUser[];
  onAdd: (id: string) => void;
  adding: string | null;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (results.length === 0) return null;
  return (
    <View style={styles.searchDropdown}>
      {results.map(u => (
        <View key={u.id} style={styles.searchResultRow}>
          <Avatar name={u.displayName} />
          <View style={styles.cardInfo}>
            <Text style={styles.cardName} numberOfLines={1}>{u.displayName}</Text>
            {u.callsign ? <Text style={styles.cardSub}>{u.callsign}</Text> : null}
          </View>
          {u.isFriend ? (
            <View style={styles.alreadyFriendBadge}><Text style={styles.alreadyFriendTxt}>Friends</Text></View>
          ) : u.requestSent ? (
            <View style={styles.sentBadge}><Text style={styles.sentBadgeTxt}>Sent</Text></View>
          ) : (
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => onAdd(u.id)}
              disabled={adding === u.id}
              accessibilityRole="button"
              accessibilityLabel={`Add ${u.displayName}`}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              {adding === u.id
                ? <ActivityIndicator color={colors.text} size="small" />
                : <Text style={styles.addBtnTxt}>+ Add</Text>}
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

// Main screen
const TABS: { id: Tab; label: string }[] = [
  { id: 'friends', label: 'Friends' },
  { id: 'requests', label: 'Requests' },
];

export default function FriendsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Deep-link / notification-tap entry point: e.g. a friend_request push
  // navigates here with ?tab=requests so the Requests tab opens directly.
  const { tab: initialTabParam } = useLocalSearchParams<{ tab?: string }>();
  const initialTab: Tab = initialTabParam === 'requests' ? 'requests' : 'friends';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [pending, setPending] = useState(0);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const tabAnim = useRef(new Animated.Value(initialTab === 'requests' ? 1 : 0)).current;
  const [tabBarW, setTabBarW] = useState(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const switchTab = (idx: number) => {
    setTab(idx === 0 ? 'friends' : 'requests');
    setQuery('');
    setSearchResults([]);
    Animated.spring(tabAnim, { toValue: idx, useNativeDriver: true, tension: 120, friction: 14 }).start();
  };

  const handleSearch = (text: string) => {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!text.trim() || text.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await apiClient.get<{ users: SearchUser[] }>(
          `/api/v1/users/search?q=${encodeURIComponent(text.trim())}&limit=5`
        );
        setSearchResults(data.users ?? []);
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 400);
  };

  const handleAdd = async (userId: string) => {
    setAdding(userId);
    try {
      await apiClient.post('/api/v1/friends/requests', { addresseeId: userId });
      setSearchResults(prev => prev.map(u => u.id === userId ? { ...u, requestSent: true } : u));
    } catch { Alert.alert('Error', 'Could not send friend request.'); }
    finally { setAdding(null); }
  };

  const invite = useCallback(async () => {
    setInviting(true);
    try {
      const { data } = await apiClient.get<{ inviteLink: string }>('/api/v1/friends/invite-link');
      await Share.share({
        message: `Join me on CORTEGE — the car enthusiast group navigation app! ${data.inviteLink}`,
        url: data.inviteLink,
      });
    } catch { Alert.alert('Error', 'Could not generate invite link.'); }
    finally { setInviting(false); }
  }, []);

  const underlineX = tabAnim.interpolate({ inputRange: [0, 1], outputRange: [0, tabBarW / 2] });

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Friends</Text>
      </View>

      {tab === 'friends' && (
        <View style={styles.searchContainer}>
          <View style={styles.searchRow}>
            {searching
              ? <ActivityIndicator size="small" color={colors.textMuted} style={styles.searchIco} />
              : <Ionicons name="search" size={16} color={colors.textMuted} style={styles.searchIco} />}
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name or callsign…"
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={handleSearch}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search friends or find new people"
            />
            {query.length > 0 && (
              <TouchableOpacity
                onPress={() => { setQuery(''); setSearchResults([]); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
              >
                <Ionicons name="close-circle" size={18} color={colors.textMuted} style={styles.searchClear} />
              </TouchableOpacity>
            )}
          </View>
          <UserSearchResults results={searchResults} onAdd={handleAdd} adding={adding} />
        </View>
      )}

      <View style={styles.tabBar} onLayout={e => setTabBarW(e.nativeEvent.layout.width)}>
        {TABS.map((t, i) => (
          <TouchableOpacity
            key={t.id}
            style={styles.tabBtn}
            onPress={() => switchTab(i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.id }}
          >
            <Text style={[styles.tabLabel, tab === t.id && styles.tabLabelActive]}>{t.label}</Text>
            {t.id === 'requests' && pending > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeTxt}>{pending > 99 ? '99+' : pending}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
        <Animated.View style={[styles.underline, { width: tabBarW / 2, transform: [{ translateX: underlineX }] }]} />
      </View>

      <View style={styles.content}>
        {tab === 'friends' && <FriendsTab query={query} />}
        {tab === 'requests' && <RequestsTab onCount={setPending} />}
      </View>

      <TouchableOpacity
        style={styles.fab}
        onPress={() => { void invite(); }}
        disabled={inviting}
        accessibilityRole="button"
        accessibilityLabel="Invite friends"
        accessibilityState={{ disabled: inviting }}
      >
        {inviting ? <ActivityIndicator color={colors.text} size="small" /> : <Ionicons name="add" size={30} color={colors.text} />}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: colors.text },

  searchContainer: { marginHorizontal: 16, marginBottom: 8, zIndex: 10 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card,
    borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, minHeight: 48,
  },
  searchIco: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 10 },
  searchClear: { paddingLeft: 8 },
  searchDropdown: {
    backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    marginTop: 4, overflow: 'hidden',
  },
  searchResultRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border,
  },

  tabBar: { flexDirection: 'row', marginHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 4 },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, minHeight: 44 },
  tabLabel: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  tabLabelActive: { color: colors.text },
  underline: { position: 'absolute', bottom: 0, height: 2, backgroundColor: colors.accent, borderRadius: 1 },
  badge: { backgroundColor: colors.accent, borderRadius: 10, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeTxt: { color: colors.text, fontSize: 10, fontWeight: '700' },

  content: { flex: 1 },
  skeletonWrap: { flex: 1, paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  listPad: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 100 },

  sectionHeader: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 16, marginBottom: 8 },
  onlineEmpty: { fontSize: 13, color: colors.textSubtle, textAlign: 'center', paddingVertical: 8 },

  card: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card,
    borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, minHeight: 72,
  },
  avatarWrap: { marginRight: 12, flexShrink: 0, position: 'relative', width: 44, height: 44 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  // Fixed white (not colors.text) — this sits on a saturated decorative
  // AVATAR_COLORS background, not theme chrome, so it must stay legible in
  // light mode too (where colors.text is near-black).
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  onlineDot: {
    position: 'absolute', bottom: 0, right: 0,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: colors.success, borderWidth: 2, borderColor: colors.card,
  },
  cardInfo: { flex: 1, marginRight: 8 },
  cardName: { fontSize: 15, fontWeight: '700', color: colors.text },
  cardSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  // Fixed indigo accent (matches the AVATAR_COLORS decorative palette above)
  // rather than a theme surface color — intentionally the same across modes.
  mutualTxt: { fontSize: 11, color: '#6366F1', marginTop: 2 },
  cardBtns: { flexDirection: 'row', gap: 8 },

  mapBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: colors.cardElevated, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  trashBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: colors.accent, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  acceptBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
  declineBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },

  addBtn: { paddingHorizontal: 14, height: 34, borderRadius: 8, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  addBtnTxt: { color: colors.text, fontSize: 13, fontWeight: '700' },
  alreadyFriendBadge: { paddingHorizontal: 10, height: 30, borderRadius: 8, backgroundColor: colors.cardElevated, alignItems: 'center', justifyContent: 'center' },
  alreadyFriendTxt: { color: colors.success, fontSize: 12, fontWeight: '600' },
  sentBadge: { paddingHorizontal: 10, height: 30, borderRadius: 8, backgroundColor: colors.cardElevated, alignItems: 'center', justifyContent: 'center' },
  sentBadgeTxt: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },

  empty: { alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 },
  emptyIcon: { marginBottom: 14 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 6, textAlign: 'center' },
  emptySub: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  errorTxt: { color: colors.accent, fontSize: 13, marginBottom: 10, textAlign: 'center' },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 20, paddingHorizontal: 22, height: 44, borderRadius: 10, backgroundColor: colors.accent,
  },
  retryIcon: { marginRight: 6 },
  retryBtnTxt: { color: colors.text, fontSize: 14, fontWeight: '700' },

  fab: {
    position: 'absolute', bottom: 28, right: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.accent, shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  });
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { apiClient } from '../services/apiClient';
import { SkeletonRow } from '../components/SkeletonLoader';
import { useGroupStore } from '../stores/groupStore';

// Types
interface Friend {
  id: string;
  displayName: string;
  callsign?: string;
  avatarUrl?: string;
  isOnline?: boolean;
  convoyInfo?: { name: string; memberCount: number } | null;
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

// Avatar colors — deterministic per name
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
  return (
    <View style={styles.avatarWrap}>
      <View style={[styles.avatar, { backgroundColor: avatarColor(name) }]}>
        <Text style={styles.avatarText}>{initials(name)}</Text>
      </View>
      {online && <View style={styles.onlineDot} />}
    </View>
  );
}

function Empty({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySub}>{sub}</Text>
    </View>
  );
}

// Friend row with slide-out animation
function FriendRow({
  friend,
  onRemove,
  removing,
}: {
  friend: Friend;
  onRemove: (id: string) => void;
  removing: boolean;
}) {
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

  const handleInviteToConvoy = async () => {
    if (!activeGroupId) return;
    try {
      const res = await fetch(`/api/v1/groups/${activeGroupId}/invite-link`);
      const { code, link } = await res.json() as { code: string; link: string };
      await Share.share({ message: `Join my convoy on CONVOY! Code: ${code}\n${link}` });
    } catch {
      Alert.alert('Error', 'Could not get invite link.');
    }
  };

  const handleTap = () => {
    const buttons: Array<{ text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }> = [
      { text: '💬 Message', onPress: () => Alert.alert('Coming Soon', 'Messaging will be available soon.') },
    ];
    if (activeGroupId) buttons.push({ text: '📨 Invite to Convoy', onPress: () => void handleInviteToConvoy() });
    buttons.push({ text: '🚫 Remove', style: 'destructive', onPress: handleRemove });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(friend.displayName, friend.callsign ? `📻 ${friend.callsign}` : undefined, buttons);
  };

  return (
    <TouchableOpacity onPress={handleTap} activeOpacity={0.85}>
    <Animated.View style={[styles.card, { transform: [{ translateX: slideAnim }], opacity: opAnim }]}>
      <Avatar name={friend.displayName} online={friend.isOnline} />
      <View style={styles.cardInfo}>
        <Text style={styles.cardName} numberOfLines={1}>{friend.displayName}</Text>
        {friend.callsign
          ? <Text style={styles.cardSub} numberOfLines={1}>{friend.callsign}</Text>
          : null}
        {friend.convoyInfo
          ? <Text style={styles.convoyStatus} numberOfLines={1}>
              In convoy · {friend.convoyInfo.memberCount} members
            </Text>
          : null}
      </View>
      <View style={styles.cardBtns}>
        <TouchableOpacity style={styles.mapBtn} accessibilityRole="button" accessibilityLabel={`View ${friend.displayName} on map`}>
          <Text style={styles.mapBtnTxt}>↗</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.trashBtn}
          onPress={handleRemove}
          disabled={removing}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${friend.displayName}`}
          accessibilityState={{ disabled: removing }}
        >
          {removing
            ? <ActivityIndicator color="#DC143C" size="small" />
            : <Text style={styles.trashBtnTxt}>✕</Text>}
        </TouchableOpacity>
      </View>
    </Animated.View>
    </TouchableOpacity>
  );
}

// Friends tab with SectionList
function FriendsTab({ query }: { query: string }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
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

  const handleRemove = async (id: string) => {
    setRemoving(id);
    try {
      await apiClient.delete(`/api/v1/friends/${id}`);
      setFriends(p => p.filter(f => f.id !== id));
    } catch { setError('Could not remove friend.'); }
    finally { setRemoving(null); }
  };

  const q = query.toLowerCase().trim();
  const filtered = q
    ? friends.filter(f =>
        f.displayName.toLowerCase().includes(q) ||
        f.callsign?.toLowerCase().includes(q))
    : friends;

  if (loading) {
    return <View style={styles.skeletonWrap}>{[0, 1, 2, 3].map(i => <SkeletonRow key={i} />)}</View>;
  }

  if (filtered.length === 0 && !error) {
    return <Empty icon="👥" title="No friends yet" sub="Use the + button to invite your crew." />;
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
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#DC143C" colors={['#DC143C']} />
      }
      ListHeaderComponent={error ? <Text style={styles.errorTxt}>{error}</Text> : null}
      renderSectionHeader={({ section }) => (
        <Text style={styles.sectionHeader}>{section.title}</Text>
      )}
      renderItem={({ item }) => (
        <FriendRow
          friend={item}
          onRemove={handleRemove}
          removing={removing === item.id}
        />
      )}
      renderSectionFooter={({ section }) =>
        section.title === 'Online Now' && offline.length === 0 ? (
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
        >
          {isMe && acting?.action === 'accept'
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.acceptBtnTxt}>✓</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.declineBtn}
          onPress={handleDecline}
          disabled={!!isMe}
          accessibilityRole="button"
          accessibilityLabel={`Decline ${req.displayName}`}
          accessibilityState={{ disabled: !!isMe }}
        >
          {isMe && acting?.action === 'decline'
            ? <ActivityIndicator color="#888" size="small" />
            : <Text style={styles.declineBtnTxt}>✕</Text>}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// Requests tab
function RequestsTab({ onCount }: { onCount: (n: number) => void }) {
  const [reqs, setReqs] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(true);
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

  const act = async (id: string, action: 'accept' | 'decline') => {
    setActing({ id, action });
    try {
      await apiClient.post(`/api/v1/friends/requests/${id}/${action}`);
      setReqs(p => p.filter(r => r.id !== id));
    } catch { setError(`Failed to ${action} request.`); }
    finally { setActing(null); }
  };

  if (loading) {
    return <View style={styles.skeletonWrap}>{[0, 1, 2].map(i => <SkeletonRow key={i} />)}</View>;
  }

  return (
    <SectionList
      sections={reqs.length > 0 ? [{ title: 'Pending', data: reqs }] : []}
      keyExtractor={item => item.id}
      contentContainerStyle={styles.listPad}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={error ? <Text style={styles.errorTxt}>{error}</Text> : null}
      ListEmptyComponent={
        !error ? <Empty icon="📬" title="No pending requests" sub="When someone adds you, they'll appear here." /> : null
      }
      renderSectionHeader={({ section }) => (
        <Text style={styles.sectionHeader}>{section.title} ({section.data.length})</Text>
      )}
      renderItem={({ item }) => (
        <RequestRow req={item} onAct={act} acting={acting} />
      )}
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
            >
              {adding === u.id
                ? <ActivityIndicator color="#fff" size="small" />
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
  const [tab, setTab] = useState<Tab>('friends');
  const [pending, setPending] = useState(0);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const tabAnim = useRef(new Animated.Value(0)).current;
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
      await apiClient.post(`/api/v1/friends/request/${userId}`);
      setSearchResults(prev => prev.map(u => u.id === userId ? { ...u, requestSent: true } : u));
    } catch { Alert.alert('Error', 'Could not send friend request.'); }
    finally { setAdding(null); }
  };

  const invite = useCallback(async () => {
    setInviting(true);
    try {
      const { data } = await apiClient.get<{ inviteLink: string }>('/api/v1/friends/invite-link');
      await Share.share({
        message: `Join me on CONVOY — the car enthusiast group navigation app! ${data.inviteLink}`,
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
            <Text style={styles.searchIco}>{searching ? '⏳' : '🔍'}</Text>
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name or callsign…"
              placeholderTextColor="#888888"
              value={query}
              onChangeText={handleSearch}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search friends or find new people"
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => { setQuery(''); setSearchResults([]); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.searchClear}>✕</Text>
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
        {inviting ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.fabIcon}>+</Text>}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  header: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: '#FFFFFF' },

  searchContainer: { marginHorizontal: 16, marginBottom: 8, zIndex: 10 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1C',
    borderRadius: 12, borderWidth: 1, borderColor: '#2A2A2A',
    paddingHorizontal: 14, minHeight: 48,
  },
  searchIco: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: '#FFFFFF', paddingVertical: 10 },
  searchClear: { color: '#888888', fontSize: 15, paddingLeft: 8 },
  searchDropdown: {
    backgroundColor: '#1C1C1C', borderRadius: 12, borderWidth: 1, borderColor: '#2A2A2A',
    marginTop: 4, overflow: 'hidden',
  },
  searchResultRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#2A2A2A',
  },

  tabBar: { flexDirection: 'row', marginHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#2A2A2A', marginBottom: 4 },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, minHeight: 44 },
  tabLabel: { fontSize: 14, fontWeight: '600', color: '#888888' },
  tabLabelActive: { color: '#FFFFFF' },
  underline: { position: 'absolute', bottom: 0, height: 2, backgroundColor: '#DC143C', borderRadius: 1 },
  badge: { backgroundColor: '#DC143C', borderRadius: 10, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeTxt: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },

  content: { flex: 1 },
  skeletonWrap: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  listPad: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 100 },

  sectionHeader: { fontSize: 12, fontWeight: '700', color: '#888888', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 16, marginBottom: 8 },
  onlineEmpty: { fontSize: 13, color: '#555555', textAlign: 'center', paddingVertical: 8 },

  card: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1C',
    borderRadius: 14, borderWidth: 1, borderColor: '#2A2A2A',
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, minHeight: 72,
  },
  avatarWrap: { marginRight: 12, flexShrink: 0, position: 'relative', width: 44, height: 44 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  onlineDot: {
    position: 'absolute', bottom: 0, right: 0,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#22C55E', borderWidth: 2, borderColor: '#1C1C1C',
  },
  cardInfo: { flex: 1, marginRight: 8 },
  cardName: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  cardSub: { fontSize: 12, color: '#888888', marginTop: 2 },
  convoyStatus: { fontSize: 12, color: '#F59E0B', marginTop: 2, fontWeight: '600' },
  mutualTxt: { fontSize: 11, color: '#6366F1', marginTop: 2 },
  cardBtns: { flexDirection: 'row', gap: 8 },

  mapBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: '#242424', borderWidth: 1, borderColor: '#2A2A2A', alignItems: 'center', justifyContent: 'center' },
  mapBtnTxt: { color: '#888888', fontSize: 16, fontWeight: '700' },
  trashBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: '#DC143C', backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  trashBtnTxt: { color: '#DC143C', fontSize: 15, fontWeight: '700' },
  acceptBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: '#22C55E', alignItems: 'center', justifyContent: 'center' },
  acceptBtnTxt: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  declineBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: '#2A2A2A', backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  declineBtnTxt: { color: '#888888', fontSize: 15, fontWeight: '700' },

  addBtn: { paddingHorizontal: 14, height: 34, borderRadius: 8, backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center' },
  addBtnTxt: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  alreadyFriendBadge: { paddingHorizontal: 10, height: 30, borderRadius: 8, backgroundColor: '#242424', alignItems: 'center', justifyContent: 'center' },
  alreadyFriendTxt: { color: '#22C55E', fontSize: 12, fontWeight: '600' },
  sentBadge: { paddingHorizontal: 10, height: 30, borderRadius: 8, backgroundColor: '#242424', alignItems: 'center', justifyContent: 'center' },
  sentBadgeTxt: { color: '#888888', fontSize: 12, fontWeight: '600' },

  empty: { alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 44, marginBottom: 14 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF', marginBottom: 6, textAlign: 'center' },
  emptySub: { fontSize: 14, color: '#888888', textAlign: 'center', lineHeight: 20 },
  errorTxt: { color: '#DC143C', fontSize: 13, marginBottom: 10, textAlign: 'center' },

  fab: {
    position: 'absolute', bottom: 28, right: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#DC143C', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  fabIcon: { color: '#FFFFFF', fontSize: 30, fontWeight: '300', lineHeight: 34 },
});

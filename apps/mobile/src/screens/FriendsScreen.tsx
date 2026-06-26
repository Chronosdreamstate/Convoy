import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiClient } from '../services/apiClient';
import { SkeletonRow } from '../components/SkeletonLoader';

// Types
interface Friend { id: string; displayName: string; callsign?: string; avatarUrl?: string; isOnline?: boolean; }
interface FriendRequest { id: string; displayName: string; avatarUrl?: string; }
type Tab = 'friends' | 'requests';

// Helpers
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
}
function Avatar({ name }: { name: string }) {
  return <View style={styles.avatar}><Text style={styles.avatarText}>{initials(name)}</Text></View>;
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

// Friends tab
function FriendsTab({ query }: { query: string }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
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

  const remove = async (id: string) => {
    setRemoving(id);
    try {
      await apiClient.delete(`/api/v1/friends/${id}`);
      setFriends(p => p.filter(f => f.id !== id));
    } catch { setError('Could not remove friend.'); }
    finally { setRemoving(null); }
  };

  const q = query.toLowerCase().trim();
  const list = q
    ? friends.filter(f => f.displayName.toLowerCase().includes(q) || f.callsign?.toLowerCase().includes(q))
    : friends;

  if (loading) return (
    <View style={styles.skeletonWrap}>{[0, 1, 2, 3].map(i => <SkeletonRow key={i} />)}</View>
  );
  return (
    <ScrollView contentContainerStyle={styles.listPad} showsVerticalScrollIndicator={false}>
      {error ? <Text style={styles.errorTxt}>{error}</Text> : null}
      {list.length === 0 && !error
        ? <Empty icon="👥" title="No friends yet" sub="Invite your crew with the button below." />
        : list.map(f => (
          <View key={f.id} style={styles.card}>
            <Avatar name={f.displayName} />
            <View style={styles.cardInfo}>
              <Text style={styles.cardName} numberOfLines={1}>{f.displayName}</Text>
              {f.callsign ? <Text style={styles.cardSub} numberOfLines={1}>{f.callsign}</Text> : null}
            </View>
            <View style={styles.cardBtns}>
              <TouchableOpacity style={styles.mapBtn} accessibilityRole="button" accessibilityLabel={`View ${f.displayName} on map`}>
                <Text style={styles.mapBtnTxt}>↗</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.trashBtn} onPress={() => remove(f.id)} disabled={removing === f.id}
                accessibilityRole="button" accessibilityLabel={`Remove ${f.displayName}`} accessibilityState={{ disabled: removing === f.id }}>
                {removing === f.id ? <ActivityIndicator color="#DC143C" size="small" /> : <Text style={styles.trashBtnTxt}>✕</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ))
      }
    </ScrollView>
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

  if (loading) return (
    <View style={styles.skeletonWrap}>{[0, 1, 2].map(i => <SkeletonRow key={i} />)}</View>
  );
  return (
    <ScrollView contentContainerStyle={styles.listPad} showsVerticalScrollIndicator={false}>
      {error ? <Text style={styles.errorTxt}>{error}</Text> : null}
      {reqs.length === 0 && !error
        ? <Empty icon="📬" title="No pending requests" sub="When someone adds you, they'll appear here." />
        : reqs.map(r => (
          <View key={r.id} style={styles.card}>
            <Avatar name={r.displayName} />
            <View style={styles.cardInfo}>
              <Text style={styles.cardName} numberOfLines={1}>{r.displayName}</Text>
              <Text style={styles.cardSub}>Wants to be friends</Text>
            </View>
            <View style={styles.cardBtns}>
              <TouchableOpacity style={styles.acceptBtn} onPress={() => act(r.id, 'accept')} disabled={acting?.id === r.id}
                accessibilityRole="button" accessibilityLabel={`Accept ${r.displayName}`} accessibilityState={{ disabled: acting?.id === r.id }}>
                {acting?.id === r.id && acting.action === 'accept'
                  ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.acceptBtnTxt}>✓</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={() => act(r.id, 'decline')} disabled={acting?.id === r.id}
                accessibilityRole="button" accessibilityLabel={`Decline ${r.displayName}`} accessibilityState={{ disabled: acting?.id === r.id }}>
                {acting?.id === r.id && acting.action === 'decline'
                  ? <ActivityIndicator color="#888" size="small" /> : <Text style={styles.declineBtnTxt}>✕</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ))
      }
    </ScrollView>
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
  const [inviting, setInviting] = useState(false);
  const tabAnim = useRef(new Animated.Value(0)).current;
  const [tabBarW, setTabBarW] = useState(0);

  const switchTab = (idx: number) => {
    setTab(idx === 0 ? 'friends' : 'requests');
    Animated.spring(tabAnim, { toValue: idx, useNativeDriver: true, tension: 120, friction: 14 }).start();
  };

  const invite = useCallback(async () => {
    setInviting(true);
    try {
      const { data } = await apiClient.get<{ inviteLink: string }>('/api/v1/friends/invite-link');
      await Share.share({ message: `Join me on CONVOY — the car enthusiast group navigation app! ${data.inviteLink}`, url: data.inviteLink });
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
        <View style={styles.searchRow}>
          <Text style={styles.searchIco}>🔍</Text>
          <TextInput style={styles.searchInput} placeholder="Search by name or callsign…" placeholderTextColor="#888888"
            value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
            returnKeyType="search" accessibilityLabel="Search friends" />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.searchClear}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={styles.tabBar} onLayout={e => setTabBarW(e.nativeEvent.layout.width)}>
        {TABS.map((t, i) => (
          <TouchableOpacity key={t.id} style={styles.tabBtn} onPress={() => switchTab(i)}
            accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }}>
            <Text style={[styles.tabLabel, tab === t.id && styles.tabLabelActive]}>{t.label}</Text>
            {t.id === 'requests' && pending > 0 && (
              <View style={styles.badge}><Text style={styles.badgeTxt}>{pending > 99 ? '99+' : pending}</Text></View>
            )}
          </TouchableOpacity>
        ))}
        <Animated.View style={[styles.underline, { width: tabBarW / 2, transform: [{ translateX: underlineX }] }]} />
      </View>

      <View style={styles.content}>
        {tab === 'friends' && <FriendsTab query={query} />}
        {tab === 'requests' && <RequestsTab onCount={setPending} />}
      </View>

      <TouchableOpacity style={styles.fab} onPress={() => { void invite(); }} disabled={inviting}
        accessibilityRole="button" accessibilityLabel="Invite friends" accessibilityState={{ disabled: inviting }}>
        {inviting ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.fabIcon}>+</Text>}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

// Styles
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  header: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: '#FFFFFF' },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1C',
    borderRadius: 12, borderWidth: 1, borderColor: '#2A2A2A',
    marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, minHeight: 48,
  },
  searchIco: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: '#FFFFFF', paddingVertical: 10 },
  searchClear: { color: '#888888', fontSize: 15, paddingLeft: 8 },

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

  card: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1C',
    borderRadius: 14, borderWidth: 1, borderColor: '#2A2A2A',
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, minHeight: 72,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center', marginRight: 12, flexShrink: 0 },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  cardInfo: { flex: 1, marginRight: 8 },
  cardName: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  cardSub: { fontSize: 12, color: '#888888', marginTop: 2 },
  cardBtns: { flexDirection: 'row', gap: 8 },

  mapBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: '#242424', borderWidth: 1, borderColor: '#2A2A2A', alignItems: 'center', justifyContent: 'center' },
  mapBtnTxt: { color: '#888888', fontSize: 16, fontWeight: '700' },
  trashBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: '#DC143C', backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  trashBtnTxt: { color: '#DC143C', fontSize: 15, fontWeight: '700' },
  acceptBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center' },
  acceptBtnTxt: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  declineBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: '#2A2A2A', backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  declineBtnTxt: { color: '#888888', fontSize: 15, fontWeight: '700' },

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

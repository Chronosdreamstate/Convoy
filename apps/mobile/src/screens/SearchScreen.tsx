import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';

const STORAGE_KEY = 'convoy:recent_searches';
const MAX_RECENT = 5;

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

function avatarColor(name: string): string {
  const colors = ['#DC143C', '#3B82F6', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'groups' | 'people'>('groups');
  const [groups, setGroups] = useState<Group[]>([]);
  const [people, setPeople] = useState<UserResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [friendActions, setFriendActions] = useState<Record<string, 'pending' | 'friends'>>({});

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => { if (raw) setRecentSearches(JSON.parse(raw) as string[]); })
      .catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 100);
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
    if (!q.trim()) { setGroups([]); setPeople([]); return; }
    setLoading(true);
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
      // silently fail
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

  const handleJoinGroup = async (groupId: string) => {
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/members`, {});
      router.push(`/group/${groupId}` as never);
    } catch {
      router.push(`/group/${groupId}` as never);
    }
  };

  const handleAddFriend = async (userId: string) => {
    try {
      await apiClient.post('/api/v1/friends', { userId });
      setFriendActions((prev) => ({ ...prev, [userId]: 'pending' }));
    } catch { /* ignore */ }
  };

  const renderGroup = ({ item }: { item: Group }) => (
    <View style={styles.card}>
      <View style={styles.cardLeft}>
        <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
        <View style={styles.pillRow}>
          <View style={styles.pill}>
            <Text style={styles.pillText}>{item.memberCount} members</Text>
          </View>
          <View style={[styles.pill, item.accessType === 'open' ? styles.pillGreen : styles.pillMuted]}>
            <Text style={styles.pillText}>{item.accessType === 'open' ? 'Public' : 'Invite'}</Text>
          </View>
          {item.nextEvent && (
            <View style={[styles.pill, styles.pillAmber]}>
              <Text style={styles.pillText}>📅 {new Date(item.nextEvent.scheduledFor).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</Text>
            </View>
          )}
        </View>
      </View>
      <TouchableOpacity style={styles.actionBtn} onPress={() => handleJoinGroup(item.id)}>
        <Text style={styles.actionBtnText}>{item.accessType === 'open' ? 'Join' : 'Request'}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderPerson = ({ item }: { item: UserResult }) => {
    const status = friendActions[item.id] ?? item.friendStatus ?? 'none';
    const initial = (item.displayName?.[0] ?? '?').toUpperCase();
    return (
      <View style={styles.card}>
        <View style={[styles.avatar, { backgroundColor: avatarColor(item.displayName) }]}>
          <Text style={styles.avatarText}>{initial}</Text>
          {item.isOnline && <View style={styles.onlineDot} />}
        </View>
        <View style={styles.cardLeft}>
          <Text style={styles.cardName}>{item.displayName}</Text>
          {item.pttCallsign ? <Text style={styles.muted}>{item.pttCallsign}</Text> : null}
        </View>
        {status === 'none' && (
          <TouchableOpacity style={styles.actionBtn} onPress={() => handleAddFriend(item.id)}>
            <Text style={styles.actionBtnText}>Add</Text>
          </TouchableOpacity>
        )}
        {status === 'pending' && (
          <View style={[styles.actionBtn, styles.actionBtnMuted]}>
            <Text style={[styles.actionBtnText, { color: '#888' }]}>Pending</Text>
          </View>
        )}
        {status === 'friends' && (
          <View style={[styles.actionBtn, styles.actionBtnMuted]}>
            <Text style={[styles.actionBtnText, { color: '#22C55E' }]}>Friends ✓</Text>
          </View>
        )}
      </View>
    );
  };

  const showRecent = !query.trim() && recentSearches.length > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.inputWrap}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder="Search groups, people..."
            placeholderTextColor="#555"
            value={query}
            onChangeText={handleQueryChange}
            returnKeyType="search"
            onSubmitEditing={() => search(query)}
            clearButtonMode="while-editing"
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
            <TouchableOpacity key={s} style={styles.recentRow} onPress={() => { setQuery(s); search(s); }}>
              <Text style={styles.recentIcon}>🕐</Text>
              <Text style={styles.recentText}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Results */}
      {loading ? (
        <ActivityIndicator color="#DC143C" style={{ marginTop: 32 }} />
      ) : query.trim() ? (
        activeTab === 'groups' ? (
          <FlatList
            data={groups}
            keyExtractor={(g) => g.id}
            renderItem={renderGroup}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No groups found for "{query}"</Text>
            }
          />
        ) : (
          <FlatList
            data={people}
            keyExtractor={(p) => p.id}
            renderItem={renderPerson}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No users found for "{query}"</Text>
            }
          />
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  backBtn: { padding: 4 },
  backText: { fontSize: 28, color: '#fff', lineHeight: 32 },
  inputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1C1C1C', borderRadius: 12, paddingHorizontal: 12, height: 48,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  input: { flex: 1, color: '#fff', fontSize: 16 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#2A2A2A' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#DC143C' },
  tabText: { fontSize: 15, color: '#888' },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  list: { padding: 12, gap: 8 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#1C1C1C', borderRadius: 12, padding: 14,
  },
  cardLeft: { flex: 1 },
  cardName: { fontSize: 15, fontWeight: '600', color: '#fff', marginBottom: 4 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  pill: { backgroundColor: '#242424', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  pillGreen: { backgroundColor: 'rgba(34,197,94,0.15)' },
  pillAmber: { backgroundColor: 'rgba(245,158,11,0.15)' },
  pillMuted: { backgroundColor: '#242424' },
  pillText: { fontSize: 11, color: '#aaa' },
  actionBtn: {
    borderWidth: 1, borderColor: '#DC143C', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  actionBtnMuted: { borderColor: '#2A2A2A' },
  actionBtnText: { fontSize: 13, fontWeight: '600', color: '#DC143C' },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 18, fontWeight: '700', color: '#fff' },
  onlineDot: {
    position: 'absolute', bottom: 1, right: 1,
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#22C55E', borderWidth: 1.5, borderColor: '#1C1C1C',
  },
  muted: { fontSize: 12, color: '#888' },
  recentSection: { padding: 16 },
  sectionLabel: { fontSize: 11, color: '#555', fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  recentRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
  recentIcon: { fontSize: 16 },
  recentText: { fontSize: 15, color: '#ccc' },
  emptyText: { textAlign: 'center', color: '#555', fontSize: 14, marginTop: 40 },
});

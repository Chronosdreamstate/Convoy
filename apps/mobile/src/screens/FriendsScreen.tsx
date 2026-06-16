import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiClient } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Friend {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

interface FriendRequest {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

interface SearchUser {
  id: string;
  displayName: string;
}

type TabId = 'friends' | 'requests' | 'find';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function Avatar({ name }: { name: string }) {
  return (
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{initials(name)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Friends tab
// ---------------------------------------------------------------------------

function FriendsTab() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<{ friends: Friend[] }>('/api/v1/friends');
      setFriends(res.data.friends);
    } catch {
      setError('Failed to load friends.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRemove = async (id: string) => {
    setRemoving(id);
    try {
      await apiClient.delete(`/api/v1/friends/${id}`);
      setFriends((prev) => prev.filter((f) => f.id !== id));
    } catch {
      setError('Failed to remove friend.');
    } finally {
      setRemoving(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#DC143C" size="large" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {friends.length === 0 && !error ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>👥</Text>
          <Text style={styles.emptyTitle}>No friends yet</Text>
          <Text style={styles.emptySubtitle}>
            Head over to "Find People" to connect with others.
          </Text>
        </View>
      ) : null}

      {friends.map((friend) => (
        <View key={friend.id} style={styles.row}>
          <Avatar name={friend.displayName} />
          <Text style={styles.rowName} numberOfLines={1}>
            {friend.displayName}
          </Text>
          <TouchableOpacity
            style={[styles.actionBtn, styles.removeBtn]}
            onPress={() => handleRemove(friend.id)}
            disabled={removing === friend.id}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${friend.displayName}`}
          >
            {removing === friend.id ? (
              <ActivityIndicator color="#f87171" size="small" />
            ) : (
              <Text style={styles.removeBtnText}>Remove</Text>
            )}
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Requests tab
// ---------------------------------------------------------------------------

function RequestsTab() {
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: string; action: 'accept' | 'decline' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<{ requests: FriendRequest[] }>(
        '/api/v1/friends/requests',
      );
      setRequests(res.data.requests);
    } catch {
      setError('Failed to load requests.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAccept = async (id: string) => {
    setActing({ id, action: 'accept' });
    try {
      await apiClient.post(`/api/v1/friends/requests/${id}/accept`);
      setRequests((prev) => prev.filter((r) => r.id !== id));
    } catch {
      setError('Failed to accept request.');
    } finally {
      setActing(null);
    }
  };

  const handleDecline = async (id: string) => {
    setActing({ id, action: 'decline' });
    try {
      await apiClient.post(`/api/v1/friends/requests/${id}/decline`);
      setRequests((prev) => prev.filter((r) => r.id !== id));
    } catch {
      setError('Failed to decline request.');
    } finally {
      setActing(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#DC143C" size="large" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {requests.length === 0 && !error ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>📬</Text>
          <Text style={styles.emptyTitle}>No pending requests</Text>
          <Text style={styles.emptySubtitle}>When someone sends you a friend request it'll appear here.</Text>
        </View>
      ) : null}

      {requests.map((req) => (
        <View key={req.id} style={styles.row}>
          <Avatar name={req.displayName} />
          <Text style={styles.rowName} numberOfLines={1}>
            {req.displayName}
          </Text>
          <View style={styles.requestActions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.acceptBtn]}
              onPress={() => handleAccept(req.id)}
              disabled={acting?.id === req.id}
              accessibilityRole="button"
              accessibilityLabel={`Accept request from ${req.displayName}`}
            >
              {acting?.id === req.id && acting.action === 'accept' ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.acceptBtnText}>Accept</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.declineBtn]}
              onPress={() => handleDecline(req.id)}
              disabled={acting?.id === req.id}
              accessibilityRole="button"
              accessibilityLabel={`Decline request from ${req.displayName}`}
            >
              {acting?.id === req.id && acting.action === 'decline' ? (
                <ActivityIndicator color="#888" size="small" />
              ) : (
                <Text style={styles.declineBtnText}>Decline</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Find People tab
// ---------------------------------------------------------------------------

function FindPeopleTab() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await apiClient.get<{ users: SearchUser[] }>(
        `/api/v1/users/search?q=${encodeURIComponent(q.trim())}`,
      );
      setResults(res.data.users);
    } catch {
      setError('Search failed. Please try again.');
    } finally {
      setSearching(false);
    }
  }, []);

  const handleChangeText = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void search(text);
    }, 400);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleAddFriend = async (userId: string) => {
    setSending(userId);
    try {
      await apiClient.post('/api/v1/friends/requests', { recipientId: userId });
      setSent((prev) => new Set(prev).add(userId));
    } catch {
      setError('Failed to send request.');
    } finally {
      setSending(null);
    }
  };

  return (
    <View style={styles.findContainer}>
      {/* Search input */}
      <View style={styles.searchBox}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name..."
          placeholderTextColor="#888888"
          value={query}
          onChangeText={handleChangeText}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search people"
        />
        {searching ? <ActivityIndicator color="#DC143C" size="small" style={styles.searchSpinner} /> : null}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {!query.trim() && results.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🔎</Text>
            <Text style={styles.emptyTitle}>Find your people</Text>
            <Text style={styles.emptySubtitle}>Type a name above to search for convoy members.</Text>
          </View>
        ) : null}

        {query.trim() && !searching && results.length === 0 && !error ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>😶</Text>
            <Text style={styles.emptyTitle}>No results</Text>
            <Text style={styles.emptySubtitle}>No one found for "{query}". Try a different name.</Text>
          </View>
        ) : null}

        {results.map((user) => (
          <View key={user.id} style={styles.row}>
            <Avatar name={user.displayName} />
            <Text style={styles.rowName} numberOfLines={1}>
              {user.displayName}
            </Text>
            {sent.has(user.id) ? (
              <View style={[styles.actionBtn, styles.sentBtn]}>
                <Text style={styles.sentBtnText}>Sent ✓</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, styles.addBtn]}
                onPress={() => handleAddFriend(user.id)}
                disabled={sending === user.id}
                accessibilityRole="button"
                accessibilityLabel={`Add ${user.displayName} as friend`}
              >
                {sending === user.id ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.addBtnText}>Add Friend</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const TABS: { id: TabId; label: string }[] = [
  { id: 'friends', label: 'Friends' },
  { id: 'requests', label: 'Requests' },
  { id: 'find', label: 'Find People' },
];

export default function FriendsScreen() {
  const [activeTab, setActiveTab] = useState<TabId>('friends');

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Friends</Text>
      </View>

      {/* Tab pills */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.id}
            style={[styles.tabPill, activeTab === tab.id && styles.tabPillActive]}
            onPress={() => setActiveTab(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.id }}
            accessibilityLabel={tab.label}
          >
            <Text
              style={[styles.tabLabel, activeTab === tab.id && styles.tabLabelActive]}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Tab content */}
      <View style={styles.content}>
        {activeTab === 'friends' && <FriendsTab />}
        {activeTab === 'requests' && <RequestsTab />}
        {activeTab === 'find' && <FindPeopleTab />}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#F0F0F0',
  },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 4,
  },
  tabPill: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  tabPillActive: {
    backgroundColor: '#DC143C',
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#888888',
  },
  tabLabelActive: {
    color: '#ffffff',
  },

  // Content
  content: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    paddingTop: 4,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },

  // Row card
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    minHeight: 64,
  },

  // Avatar
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  avatarText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },

  rowName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: '#F0F0F0',
    marginRight: 8,
  },

  // Action buttons
  actionBtn: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
  },
  removeBtn: {
    borderWidth: 1,
    borderColor: '#f87171',
    backgroundColor: 'transparent',
  },
  removeBtnText: {
    color: '#f87171',
    fontSize: 13,
    fontWeight: '600',
  },
  requestActions: {
    flexDirection: 'row',
    gap: 8,
  },
  acceptBtn: {
    backgroundColor: '#DC143C',
  },
  acceptBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  declineBtn: {
    borderWidth: 1,
    borderColor: '#555555',
    backgroundColor: 'transparent',
  },
  declineBtnText: {
    color: '#888888',
    fontSize: 13,
    fontWeight: '600',
  },
  addBtn: {
    backgroundColor: '#DC143C',
  },
  addBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  sentBtn: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#22c55e',
  },
  sentBtnText: {
    color: '#22c55e',
    fontSize: 13,
    fontWeight: '600',
  },

  // Find People
  findContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 14,
    marginBottom: 12,
    minHeight: 52,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#F0F0F0',
    paddingVertical: 12,
  },
  searchSpinner: {
    marginLeft: 8,
  },

  // Empty states
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F0F0F0',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 20,
  },

  // Errors
  errorText: {
    color: '#f87171',
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'center',
  },
});

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Friend {
  id: string;
  displayName: string;
  avatarUrl?: string;
  isOnline?: boolean;
}

interface FriendRequest {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

interface SearchUser {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  pttCallsign?: string | null;
  friendshipStatus?: string | null;
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
    setError(null);
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
      <View style={styles.skeletonContainer}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.skeletonRow}>
            <View style={styles.skeletonAvatar} />
            <View style={styles.skeletonLines}>
              <View style={[styles.skeletonLine, { width: '55%' }]} />
              <View style={[styles.skeletonLine, { width: '35%', marginTop: 6 }]} />
            </View>
            <View style={styles.skeletonBtn} />
          </View>
        ))}
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
            Add someone by username in "Find People".
          </Text>
        </View>
      ) : null}

      {friends.map((friend) => (
        <View key={friend.id} style={styles.row}>
          <Avatar name={friend.displayName} />
          <View style={styles.rowInfo}>
            <Text style={styles.rowName} numberOfLines={1}>
              {friend.displayName}
            </Text>
            <Text style={[styles.rowStatus, friend.isOnline ? styles.statusOnline : styles.statusOffline]}>
              {friend.isOnline ? '● Online' : '○ Offline'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.actionBtn, styles.removeBtn]}
            onPress={() => handleRemove(friend.id)}
            disabled={removing === friend.id}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${friend.displayName}`}
            accessibilityState={{ disabled: removing === friend.id }}
          >
            {removing === friend.id ? (
              <ActivityIndicator color="#DC143C" size="small" />
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

function RequestsTab({ onCountChange }: { onCountChange?: (n: number) => void }) {
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

  useEffect(() => {
    onCountChange?.(requests.length);
  }, [requests.length, onCountChange]);

  const handleAccept = async (id: string) => {
    setActing({ id, action: 'accept' });
    setError(null);
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
    setError(null);
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
      <View style={styles.skeletonContainer}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.skeletonRow}>
            <View style={styles.skeletonAvatar} />
            <View style={styles.skeletonLines}>
              <View style={[styles.skeletonLine, { width: '55%' }]} />
              <View style={[styles.skeletonLine, { width: '35%', marginTop: 6 }]} />
            </View>
            <View style={styles.skeletonBtn} />
            <View style={[styles.skeletonBtn, { marginLeft: 6 }]} />
          </View>
        ))}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {requests.length > 0 && (
        <View style={styles.sectionHeader}>
          <View style={styles.sectionBadge}>
            <Text style={styles.sectionBadgeText}>PENDING ({requests.length})</Text>
          </View>
        </View>
      )}

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
          <View style={styles.rowInfo}>
            <Text style={styles.rowName} numberOfLines={1}>
              {req.displayName}
            </Text>
            <Text style={styles.rowStatusMuted}>Wants to be friends</Text>
          </View>
          <View style={styles.requestActions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.acceptBtn]}
              onPress={() => handleAccept(req.id)}
              disabled={acting?.id === req.id}
              accessibilityRole="button"
              accessibilityLabel={`Accept request from ${req.displayName}`}
              accessibilityState={{ disabled: acting?.id === req.id }}
            >
              {acting?.id === req.id && acting.action === 'accept' ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.acceptBtnText}>✓</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.declineBtn]}
              onPress={() => handleDecline(req.id)}
              disabled={acting?.id === req.id}
              accessibilityRole="button"
              accessibilityLabel={`Decline request from ${req.displayName}`}
              accessibilityState={{ disabled: acting?.id === req.id }}
            >
              {acting?.id === req.id && acting.action === 'decline' ? (
                <ActivityIndicator color="#888" size="small" />
              ) : (
                <Text style={styles.declineBtnText}>✗</Text>
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
        `/api/v1/friends/search?q=${encodeURIComponent(q.trim())}`,
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
    if (!text.trim()) setResults([]);
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
      await apiClient.post('/api/v1/friends/requests', { addresseeId: userId });
      setSent((prev) => new Set(prev).add(userId));
    } catch {
      setError('Failed to send request.');
    } finally {
      setSending(null);
    }
  };

  return (
    <View style={styles.findContainer}>
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
            <View style={styles.rowInfo}>
              <Text style={styles.rowName} numberOfLines={1}>
                {user.displayName}
              </Text>
              {user.pttCallsign ? (
                <Text style={styles.rowSub} numberOfLines={1}>📻 {user.pttCallsign}</Text>
              ) : null}
            </View>
            {user.friendshipStatus === 'accepted' ? (
              <View style={[styles.actionBtn, styles.sentBtn]}>
                <Text style={styles.sentBtnText}>Friends ✓</Text>
              </View>
            ) : user.friendshipStatus === 'pending' || sent.has(user.id) ? (
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
                accessibilityState={{ disabled: sending === user.id }}
              >
                {sending === user.id ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.addBtnText}>+ Add</Text>
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
  const [pendingCount, setPendingCount] = useState(0);
  const [isInviting, setIsInviting] = useState(false);
  const [showInviteQR, setShowInviteQR] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [isLoadingQR, setIsLoadingQR] = useState(false);

  const handleInvite = useCallback(async () => {
    setIsInviting(true);
    try {
      const res = await apiClient.get<{ inviteLink: string }>('/api/v1/friends/invite-link');
      await Share.share({
        message: `Join me on CONVOY — the car enthusiast group navigation app! ${res.data.inviteLink}`,
        url: res.data.inviteLink,
      });
    } catch {
      Alert.alert('Error', 'Could not generate invite link.');
    } finally {
      setIsInviting(false);
    }
  }, []);

  const handleShowQR = useCallback(async () => {
    setIsLoadingQR(true);
    try {
      const res = await apiClient.get<{ inviteLink: string }>('/api/v1/friends/invite-link');
      setInviteLink(res.data.inviteLink);
      setShowInviteQR(true);
    } catch {
      Alert.alert('Error', 'Could not generate invite link.');
    } finally {
      setIsLoadingQR(false);
    }
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Friends</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.qrInviteBtn}
            onPress={() => { void handleShowQR(); }}
            disabled={isLoadingQR}
            accessibilityRole="button"
            accessibilityLabel="Show QR code invite"
            accessibilityState={{ disabled: isLoadingQR }}
          >
            {isLoadingQR
              ? <ActivityIndicator color="#DC143C" size="small" />
              : <Text style={styles.inviteBtnText}>QR</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.inviteBtn}
            onPress={() => { void handleInvite(); }}
            disabled={isInviting}
            accessibilityRole="button"
            accessibilityLabel="Invite friends"
            accessibilityState={{ disabled: isInviting }}
          >
            {isInviting
              ? <ActivityIndicator color="#DC143C" size="small" />
              : <Text style={styles.inviteBtnText}>+ Invite</Text>
            }
          </TouchableOpacity>
        </View>
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
            {tab.id === 'requests' && pendingCount > 0 && (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>{pendingCount > 99 ? '99+' : pendingCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Tab content */}
      <View style={styles.content}>
        {activeTab === 'friends' && <FriendsTab />}
        {activeTab === 'requests' && <RequestsTab onCountChange={setPendingCount} />}
        {activeTab === 'find' && <FindPeopleTab />}
      </View>

      {/* QR invite modal (Req 17.2) */}
      <Modal
        visible={showInviteQR}
        transparent
        animationType="fade"
        onRequestClose={() => setShowInviteQR(false)}
        accessibilityViewIsModal
      >
        <TouchableOpacity
          style={styles.qrOverlay}
          activeOpacity={1}
          onPress={() => setShowInviteQR(false)}
          accessibilityRole="button"
          accessibilityLabel="Close QR invite"
        >
          <View style={styles.qrCard}>
            <Text style={styles.qrTitle}>Friend Invite</Text>
            <Text style={styles.qrSubtitle}>Scan to send me a friend request</Text>
            {inviteLink ? (
              <Image
                style={styles.qrImage}
                source={{
                  uri: `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(inviteLink)}`,
                }}
                accessibilityLabel="QR code for friend invite"
              />
            ) : (
              <ActivityIndicator color="#DC143C" style={styles.qrImage} />
            )}
            <Text style={styles.qrDismiss}>Tap anywhere to close</Text>
          </View>
        </TouchableOpacity>
      </Modal>
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#F0F0F0',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inviteBtn: {
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 36,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#DC143C',
  },
  qrInviteBtn: {
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#DC143C',
  },
  inviteBtnText: {
    color: '#DC143C',
    fontSize: 13,
    fontWeight: '700',
  },

  // QR modal
  qrOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrCard: {
    backgroundColor: '#1A1A1A',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    width: 300,
  },
  qrTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  qrSubtitle: { color: '#888', fontSize: 13, marginBottom: 16, textAlign: 'center' },
  qrImage: { width: 240, height: 240, borderRadius: 8, marginBottom: 16 },
  qrDismiss: { color: '#555', fontSize: 11 },

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
    flexDirection: 'row',
    gap: 6,
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
  tabBadge: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  tabBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
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
  skeletonContainer: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    opacity: 0.6,
    gap: 12,
  },
  skeletonAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#2A2A2A',
    flexShrink: 0,
  },
  skeletonLines: {
    flex: 1,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2A2A2A',
  },
  skeletonBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#2A2A2A',
    flexShrink: 0,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },

  // Section header for pending requests
  sectionHeader: {
    marginBottom: 12,
  },
  sectionBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#DC143C',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sectionBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
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
    minHeight: 72,
  },

  // Avatar — 48px
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  avatarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // Row info: name + status stacked
  rowInfo: {
    flex: 1,
    marginRight: 8,
  },
  rowName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F0F0F0',
  },
  rowSub: {
    fontSize: 12,
    color: '#888888',
    marginTop: 2,
  },
  rowStatus: {
    fontSize: 12,
    marginTop: 2,
    fontWeight: '500',
  },
  rowStatusMuted: {
    fontSize: 12,
    color: '#888888',
    marginTop: 2,
  },
  statusOnline: {
    color: '#22C55E',
  },
  statusOffline: {
    color: '#555555',
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
    borderColor: '#DC143C',
    backgroundColor: 'transparent',
  },
  removeBtnText: {
    color: '#DC143C',
    fontSize: 13,
    fontWeight: '600',
  },
  requestActions: {
    flexDirection: 'row',
    gap: 8,
  },
  acceptBtn: {
    backgroundColor: '#22C55E',
    minWidth: 44,
  },
  acceptBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  declineBtn: {
    borderWidth: 1,
    borderColor: '#555555',
    backgroundColor: 'transparent',
    minWidth: 44,
  },
  declineBtnText: {
    color: '#888888',
    fontSize: 18,
    fontWeight: '700',
  },
  addBtn: {
    backgroundColor: '#DC143C',
  },
  addBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  sentBtn: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#22C55E',
  },
  sentBtnText: {
    color: '#22C55E',
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
    color: '#DC143C',
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'center',
  },
});

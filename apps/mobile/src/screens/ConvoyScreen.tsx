/**
 * ConvoyScreen — group creation, joining, and management.
 * Requirements: 7.1–7.9, 8.4–8.5, 9.1–9.3, 15.4, 36.5, 36.6
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as ExpoLocation from 'expo-location';
import { apiClient } from '../services/apiClient';
import { useGroupStore } from '../stores/groupStore';
import { useSocketStore } from '../stores/socketStore';
import { useLocationStore } from '../stores/locationStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConvoyGroup {
  id: string;
  name: string;
  joinCode: string;
  adminId: string;
  status: 'active' | 'ended';
  memberCount: number;
  gapThresholdM: number;
}

interface PttChannel {
  id: string;
  name: string;
  isAll: boolean;
  memberCount: number;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const GAP_OPTIONS = [
  { label: '500 m', value: 500 },
  { label: '1 km', value: 1000 },
  { label: '2 km', value: 2000 },
  { label: '5 km', value: 5000 },
];

interface GroupMember {
  userId: string;
  displayName: string;
  isMuted: boolean;
  isOnline?: boolean;
  speedKph?: number;
  distanceM?: number;
}

interface Props {
  userId: string;
}

// Shape of each member object returned by GET /groups/:id/members
interface MemberApiItem {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  pttCallsign?: string | null;
  isAdmin: boolean;
  isMuted: boolean;
  joinedAt: string;
}

// ---------------------------------------------------------------------------
// ConvoyScreen
// ---------------------------------------------------------------------------

export default function ConvoyScreen({ userId }: Props) {
  const [group, setGroup] = useState<ConvoyGroup | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [groupName, setGroupName] = useState('');
  const [view, setView] = useState<'home' | 'create' | 'join' | 'discover'>('home');

  const [pttChannels, setPttChannels] = useState<PttChannel[]>([]);
  const [activePttChannelId, setActivePttChannelId] = useState<string | null>(null);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');

  const [publicGroups, setPublicGroups] = useState<ConvoyGroup[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const { socket } = useSocketStore();
  const { memberLocations } = useLocationStore();

  const setActiveGroupId = useGroupStore((s) => s.setActiveGroupId);
  const setPttChannelId = useGroupStore((s) => s.setPttChannelId);

  // Keep global group store in sync so the map tab can read the active group id
  useEffect(() => {
    setActiveGroupId(group?.id ?? null);
  }, [group?.id, setActiveGroupId]);

  // Sync active PTT channel to global store
  useEffect(() => {
    setPttChannelId(activePttChannelId);
  }, [activePttChannelId, setPttChannelId]);

  // Fetch PTT channels when group loads / changes
  const fetchChannels = useCallback(async (groupId: string) => {
    try {
      const res = await apiClient.get<PttChannel[]>(`/api/v1/groups/${groupId}/channels`);
      setPttChannels(res.data);
      // Auto-join "All" channel if not already in a channel
      setActivePttChannelId((prev) => {
        if (prev) return prev;
        return res.data.find((c) => c.isAll)?.id ?? null;
      });
    } catch { /* silently fail */ }
  }, []);

  useEffect(() => {
    if (!group) {
      setPttChannels([]);
      setActivePttChannelId(null);
      return;
    }
    void fetchChannels(group.id);
  }, [group?.id, fetchChannels]);

  const handleJoinChannel = useCallback(async (channelId: string) => {
    if (!group || channelId === activePttChannelId) return;
    try {
      await apiClient.post(`/api/v1/groups/${group.id}/channels/${channelId}/join`);
      setActivePttChannelId(channelId);
    } catch {
      Alert.alert('Error', 'Could not switch PTT channel.');
    }
  }, [group, activePttChannelId]);

  const handleCreateChannel = useCallback(async () => {
    if (!group || !newChannelName.trim()) return;
    try {
      const res = await apiClient.post<PttChannel>(
        `/api/v1/groups/${group.id}/channels`,
        { name: newChannelName.trim() },
      );
      setPttChannels((prev) => [...prev, res.data]);
      setNewChannelName('');
      setShowNewChannel(false);
    } catch {
      Alert.alert('Error', 'Could not create channel.');
    }
  }, [group, newChannelName]);

  const fetchPublicGroups = useCallback(async () => {
    setDiscoverLoading(true);
    try {
      const res = await apiClient.get<{ groups: ConvoyGroup[] }>('/api/v1/groups/public');
      setPublicGroups(res.data.groups);
    } catch {
      Alert.alert('Error', 'Could not load public convoys.');
    } finally {
      setDiscoverLoading(false);
    }
  }, []);

  const handleJoinByCode = useCallback(async (code: string) => {
    setLoading(true);
    try {
      const res = await apiClient.post<ConvoyGroup>('/api/v1/groups/join', { code: code.toUpperCase() });
      setGroup(res.data);
      setView('home');
      ExpoLocation.requestBackgroundPermissionsAsync().catch(() => {});
    } catch {
      Alert.alert('Error', 'Could not join group.');
    } finally {
      setLoading(false);
    }
  }, []);

  const isAdmin = group?.adminId === userId;

  // ── Helper: fetch and normalise the members list ──────────────────────────
  const fetchMembers = useCallback((groupId: string) => {
    apiClient
      .get<{ members: MemberApiItem[] }>(`/api/v1/groups/${groupId}/members`)
      .then((res) => {
        const normalised: GroupMember[] = res.data.members.map((m) => ({
          userId: m.userId,
          displayName: m.displayName ?? '',
          isMuted: m.isMuted,
        }));
        setMembers(normalised);
      })
      .catch(() => {/* silently fail – user will see empty list */});
  }, []);

  // ── Load members when group becomes non-null ──────────────────────────────
  useEffect(() => {
    if (!group) return;
    fetchMembers(group.id);
  }, [group?.id, fetchMembers]);

  // ── Socket: listen for group:ended using the shared MapScreen socket ────
  useEffect(() => {
    if (!socket || !group) return;
    const handleGroupEnded = () => {
      setGroup(null);
      setMembers([]);
      setView('home');
    };
    socket.on('group:ended', handleGroupEnded);
    return () => { socket.off('group:ended', handleGroupEnded); };
  }, [socket, group]);

  // ── Gap threshold (Admin only) ────────────────────────────────────────────
  const handleSetGapThreshold = useCallback(async (metres: number) => {
    if (!group) return;
    try {
      await apiClient.patch(`/api/v1/groups/${group.id}/settings`, { gapThresholdM: metres });
      setGroup((prev) => prev ? { ...prev, gapThresholdM: metres } : null);
    } catch {
      Alert.alert('Error', 'Could not update gap threshold.');
    }
  }, [group]);

  // ── Create group (Req 7.1–7.3) ────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!groupName.trim()) return Alert.alert('Error', 'Enter a group name.');
    setLoading(true);
    try {
      const res = await apiClient.post<ConvoyGroup>('/api/v1/groups', { name: groupName.trim() });
      setGroup(res.data);
      setView('home');
      setGroupName('');
      ExpoLocation.requestBackgroundPermissionsAsync().catch(() => {});
    } catch {
      Alert.alert('Error', 'Could not create group.');
    } finally {
      setLoading(false);
    }
  }, [groupName]);

  // ── Join group (Req 7.4) ──────────────────────────────────────────────────
  const handleJoin = useCallback(async () => {
    if (joinCode.trim().length !== 6) return Alert.alert('Error', 'Enter a 6-character join code.');
    setLoading(true);
    try {
      const res = await apiClient.post<ConvoyGroup>('/api/v1/groups/join', { code: joinCode.trim().toUpperCase() });
      setGroup(res.data);
      setView('home');
      setJoinCode('');
      ExpoLocation.requestBackgroundPermissionsAsync().catch(() => {});
    } catch {
      Alert.alert('Error', 'Invalid join code or group not found.');
    } finally {
      setLoading(false);
    }
  }, [joinCode]);

  // ── Share join code (Req 7.3) ─────────────────────────────────────────────
  const handleShareCode = useCallback(async () => {
    if (!group) return;
    try {
      await Share.share({
        message: `Join my CONVOY group "${group.name}" with code: ${group.joinCode}\nhttps://convoy.app/join/${group.joinCode}`,
      });
    } catch { /* user cancelled share sheet */ }
  }, [group]);

  // ── Copy join code — copies to clipboard, falls back to share ──
  const handleCopyCode = useCallback(async () => {
    if (!group) return;
    try {
      await Clipboard.setStringAsync(group.joinCode);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      try {
        await Share.share({ message: `Join my convoy! Code: ${group.joinCode}` });
      } catch { /* user cancelled */ }
    }
  }, [group]);

  // ── Leave group (Req 7.7) ─────────────────────────────────────────────────
  const handleLeave = useCallback(() => {
    const currentGroup = group;
    if (!currentGroup) return;
    Alert.alert('Leave Group', 'Are you sure you want to leave this convoy?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.post(`/api/v1/groups/${currentGroup.id}/leave`);
            setGroup(null);
            setMembers([]);
            setView('home');
          } catch {
            Alert.alert('Error', 'Could not leave group.');
          }
        },
      },
    ]);
  }, [group]);

  // ── End group (Admin only, Req 7.9) ──────────────────────────────────────
  const handleEnd = useCallback(() => {
    const currentGroup = group;
    if (!currentGroup) return;
    Alert.alert('End Convoy', 'This will end the session for all members.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Convoy',
        style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.post(`/api/v1/groups/${currentGroup.id}/end`);
            setGroup(null);
            setMembers([]);
            setView('home');
          } catch {
            Alert.alert('Error', 'Could not end convoy.');
          }
        },
      },
    ]);
  }, [group]);

  // ── Mute member (Admin only, Req 10.11) ──────────────────────────────────
  const handleMute = useCallback(async (memberId: string) => {
    if (!group) return;
    const target = members.find((m) => m.userId === memberId);
    if (!target) return;
    const newMuted = !target.isMuted;
    try {
      await apiClient.post(`/api/v1/groups/${group.id}/members/${memberId}/mute`, { muted: newMuted });
      // Re-fetch to stay in sync with server state
      fetchMembers(group.id);
    } catch {
      Alert.alert('Error', 'Could not mute member.');
      // No optimistic update was applied, so no rollback needed
    }
  }, [group, members, fetchMembers]);

  // ── Kick member (Admin only) ──────────────────────────────────────────────
  const handleKick = useCallback((memberId: string) => {
    if (!group) return;
    Alert.alert('Kick member', 'Remove this member?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.delete(`/api/v1/groups/${group.id}/members/${memberId}`);
            setMembers((prev) => prev.filter((m) => m.userId !== memberId));
          } catch {
            Alert.alert('Error', 'Could not kick member.');
          }
        },
      },
    ]);
  }, [group]);

  // ── Home: no group ────────────────────────────────────────────────────────
  if (!group) {
    if (view === 'create') {
      return (
        <SafeAreaView style={styles.container}>
          <Text style={styles.title}>Create Convoy</Text>
          <TextInput
            style={styles.input}
            placeholder="Group name"
            placeholderTextColor="#555555"
            value={groupName}
            onChangeText={setGroupName}
            autoFocus
          />
          <TouchableOpacity style={styles.primaryBtn} onPress={handleCreate} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Create</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setView('home')}>
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }

    if (view === 'join') {
      return (
        <SafeAreaView style={styles.container}>
          <Text style={styles.title}>Join Convoy</Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            placeholder="Enter 6-char code"
            placeholderTextColor="#555555"
            value={joinCode}
            onChangeText={setJoinCode}
            autoCapitalize="characters"
            maxLength={6}
            autoFocus
          />
          <TouchableOpacity style={styles.primaryBtn} onPress={handleJoin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Join</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setView('home')}>
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }

    if (view === 'discover') {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.headerBar}>
            <Text style={styles.headerTitle}>DISCOVER</Text>
            <TouchableOpacity onPress={() => setView('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.headerBack}>← Back</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.secondaryBtn, { marginBottom: 16 }]}
            onPress={fetchPublicGroups}
            disabled={discoverLoading}
          >
            {discoverLoading
              ? <ActivityIndicator color="#888888" />
              : <Text style={styles.secondaryBtnText}>Refresh</Text>}
          </TouchableOpacity>
          <FlatList
            data={publicGroups}
            keyExtractor={(g) => g.id}
            renderItem={({ item: g }) => (
              <View style={styles.discoverRow}>
                <View style={styles.discoverInfo}>
                  <Text style={styles.discoverName}>{g.name}</Text>
                  <Text style={styles.discoverMeta}>{g.memberCount} member{g.memberCount !== 1 ? 's' : ''} · Open</Text>
                </View>
                <TouchableOpacity
                  style={styles.discoverJoinBtn}
                  onPress={() => void handleJoinByCode(g.joinCode)}
                  disabled={loading}
                >
                  <Text style={styles.discoverJoinText}>Join</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={
              <View style={styles.emptyMembers}>
                <Text style={styles.emptyMembersText}>
                  {discoverLoading ? 'Loading…' : 'No open convoys found. Tap Refresh to search.'}
                </Text>
              </View>
            }
          />
        </SafeAreaView>
      );
    }

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.emptyHero}>
          <Text style={styles.emptyEmoji}>🚗</Text>
          <Text style={styles.title}>No Active Convoy</Text>
          <Text style={styles.subtitle}>Start or join a driving group</Text>
        </View>
        <View style={styles.homeActions}>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setView('create')}>
            <Text style={styles.primaryBtnText}>Create Group</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setView('join')}>
            <Text style={styles.secondaryBtnText}>Join with Code</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => { setView('discover'); void fetchPublicGroups(); }}
          >
            <Text style={styles.secondaryBtnText}>Browse Open Convoys</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Active group view ─────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      {/* Header bar */}
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>CONVOY</Text>
        <View style={styles.memberCountBadge}>
          <Text style={styles.memberCountText}>{members.length} members</Text>
        </View>
      </View>

      {/* Group info card */}
      <View style={styles.groupCard}>
        <Text style={styles.groupName}>{group.name}</Text>

        {/* Join code row with copy button */}
        <View style={styles.joinCodeRow}>
          <Text style={styles.joinCodeLabel}>Join Code</Text>
          <Text style={styles.joinCodeValue}>{group.joinCode}</Text>
          <TouchableOpacity
            style={styles.copyBtn}
            onPress={handleCopyCode}
            accessibilityLabel="Copy join code"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.copyBtnText, copyFeedback && { color: '#22c55e' }]}>
              {copyFeedback ? '✓ Copied' : 'Copy'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shareCodeBtn}
            onPress={handleShareCode}
            accessibilityLabel="Share join code"
          >
            <Text style={styles.shareCodeText}>Share</Text>
          </TouchableOpacity>
        </View>

        {/* Gap threshold — admin only */}
        {isAdmin && (
          <View style={styles.gapSection}>
            <Text style={styles.gapLabel}>GAP ALERT DISTANCE</Text>
            <View style={styles.gapOptions}>
              {GAP_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.gapChip, group.gapThresholdM === opt.value && styles.gapChipActive]}
                  onPress={() => void handleSetGapThreshold(opt.value)}
                  accessibilityLabel={`Set gap threshold to ${opt.label}`}
                >
                  <Text style={[styles.gapChipText, group.gapThresholdM === opt.value && styles.gapChipTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* PTT channel selector */}
        {pttChannels.length > 0 && (
          <View style={styles.channelSection}>
            <Text style={styles.gapLabel}>PTT CHANNEL</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.channelRow}>
              {pttChannels.map((ch) => (
                <TouchableOpacity
                  key={ch.id}
                  style={[styles.channelChip, activePttChannelId === ch.id && styles.channelChipActive]}
                  onPress={() => void handleJoinChannel(ch.id)}
                  accessibilityLabel={`Switch to channel ${ch.name}`}
                >
                  <Text style={[styles.channelChipText, activePttChannelId === ch.id && styles.channelChipTextActive]}>
                    {ch.isAll ? '📢 All' : `# ${ch.name}`}
                  </Text>
                </TouchableOpacity>
              ))}
              {isAdmin && !showNewChannel && (
                <TouchableOpacity
                  style={styles.channelNewChip}
                  onPress={() => setShowNewChannel(true)}
                  accessibilityLabel="Create new PTT channel"
                >
                  <Text style={styles.channelNewText}>+ Channel</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
            {isAdmin && showNewChannel && (
              <View style={styles.newChannelRow}>
                <TextInput
                  style={[styles.input, styles.newChannelInput]}
                  placeholder="Channel name"
                  placeholderTextColor="#555555"
                  value={newChannelName}
                  onChangeText={setNewChannelName}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={() => void handleCreateChannel()}
                />
                <TouchableOpacity
                  style={styles.newChannelAdd}
                  onPress={() => void handleCreateChannel()}
                >
                  <Text style={styles.newChannelAddText}>Add</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.newChannelCancel}
                  onPress={() => { setShowNewChannel(false); setNewChannelName(''); }}
                >
                  <Text style={styles.newChannelCancelText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </View>

      <Text style={styles.sectionLabel}>MEMBERS ({members.length})</Text>

      <FlatList
        data={members}
        keyExtractor={(m) => m.userId}
        style={styles.memberList}
        renderItem={({ item: m }) => {
          const mLoc = memberLocations[m.userId];
          const adminLoc = memberLocations[group.adminId];
          const distFromLead = mLoc && adminLoc && m.userId !== group.adminId
            ? haversineM(adminLoc.lat, adminLoc.lng, mLoc.lat, mLoc.lng)
            : null;
          const isLive = !!memberLocations[m.userId];
          return (
          <View style={styles.memberRow}>
            {/* Online/offline dot */}
            <View style={[styles.statusDot, isLive ? styles.dotOnline : styles.dotOffline]} />

            <View style={styles.memberInfo}>
              <Text style={styles.memberName}>{m.displayName}</Text>
              <View style={styles.memberMetaRow}>
                {mLoc && (
                  <Text style={styles.memberMeta}>💨 {mLoc.speedKph.toFixed(0)} km/h</Text>
                )}
                {distFromLead != null && (
                  <Text style={styles.memberMeta}>📍 {(distFromLead / 1000).toFixed(1)} km from lead</Text>
                )}
              </View>
            </View>

            {isAdmin && m.userId !== userId && (
              <View style={styles.adminActions}>
                <TouchableOpacity
                  style={[styles.muteBtn, m.isMuted && styles.muteBtnActive]}
                  onPress={() => void handleMute(m.userId)}
                >
                  <Text style={styles.muteBtnText}>{m.isMuted ? 'Unmute' : 'Mute'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.kickBtn}
                  onPress={() => handleKick(m.userId)}
                >
                  <Text style={styles.kickBtnText}>Kick</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyMembers}>
            <Text style={styles.emptyMembersText}>Waiting for members to join…</Text>
          </View>
        }
      />

      {/* Actions — clearly separated from the list */}
      <View style={styles.actions}>
        <View style={styles.actionsDivider} />
        {isAdmin && (
          <TouchableOpacity style={styles.dangerBtn} onPress={handleEnd}>
            <Text style={styles.dangerBtnText}>🛑  End Convoy</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.secondaryBtn} onPress={handleLeave}>
          <Text style={styles.secondaryBtnText}>Leave Convoy</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A', padding: 16 },

  // Header bar
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingTop: 4,
  },
  headerTitle: {
    color: '#F0F0F0',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 3,
  },
  memberCountBadge: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  memberCountText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },

  // Empty / home state
  emptyHero: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyEmoji: { fontSize: 64, marginBottom: 16 },
  homeActions: { paddingBottom: 8 },

  title: { color: '#F0F0F0', fontSize: 24, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  subtitle: { color: '#888888', fontSize: 14, marginBottom: 32, textAlign: 'center' },

  input: {
    backgroundColor: '#1C1C1C', color: '#F0F0F0', borderRadius: 10,
    padding: 14, fontSize: 16, marginBottom: 12,
    borderWidth: 1, borderColor: '#2A2A2A',
  },
  codeInput: { letterSpacing: 8, textAlign: 'center', fontSize: 22, fontWeight: '700', fontFamily: 'monospace' },

  primaryBtn: {
    backgroundColor: '#DC143C', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10, minHeight: 52,
    justifyContent: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    backgroundColor: '#1C1C1C', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10, minHeight: 52,
    justifyContent: 'center', borderWidth: 1, borderColor: '#2A2A2A',
  },
  secondaryBtnText: { color: '#888888', fontWeight: '600', fontSize: 15 },
  dangerBtn: {
    backgroundColor: '#1A0505', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10, minHeight: 52,
    justifyContent: 'center', borderWidth: 1, borderColor: '#5C1010',
  },
  dangerBtnText: { color: '#FF8080', fontWeight: '700', fontSize: 15 },

  // Group card
  groupCard: {
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  groupName: { color: '#F0F0F0', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  joinCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  joinCodeLabel: { color: '#555555', fontSize: 12, fontWeight: '600' },
  joinCodeValue: {
    color: '#DC143C',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 4,
    fontFamily: 'monospace',
    flex: 1,
  },
  copyBtn: {
    backgroundColor: '#2A2A2A',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  copyBtnText: { color: '#888888', fontSize: 12, fontWeight: '600' },
  shareCodeBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  shareCodeText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  // Gap threshold
  gapSection: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#2A2A2A' },
  gapLabel: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 },
  gapOptions: { flexDirection: 'row', gap: 8 },
  gapChip: {
    flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0A0A0A',
    borderWidth: 1, borderColor: '#2A2A2A', alignItems: 'center', minHeight: 36, justifyContent: 'center',
  },
  gapChipActive: { borderColor: '#DC143C', backgroundColor: '#1A0505' },
  gapChipText: { color: '#555555', fontSize: 12, fontWeight: '600' },
  gapChipTextActive: { color: '#DC143C' },

  sectionLabel: { color: '#555555', fontSize: 11, fontWeight: '700', marginBottom: 8, letterSpacing: 1.5 },
  memberList: { flex: 1 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 60,
    gap: 10,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotOnline: { backgroundColor: '#22c55e' },
  dotOffline: { backgroundColor: '#444444' },
  memberInfo: { flex: 1 },
  memberName: { color: '#F0F0F0', fontSize: 15, fontWeight: '600' },
  memberMetaRow: { flexDirection: 'row', gap: 10, marginTop: 3 },
  memberMeta: { color: '#555555', fontSize: 12 },
  adminActions: { flexDirection: 'row', gap: 6 },
  muteBtn: {
    backgroundColor: '#2A2A2A', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, minWidth: 64,
    alignItems: 'center', minHeight: 36, justifyContent: 'center',
  },
  muteBtnActive: { backgroundColor: '#DC143C' },
  muteBtnText: { color: '#F0F0F0', fontSize: 12, fontWeight: '600' },
  kickBtn: {
    backgroundColor: '#1A0505', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, minWidth: 48,
    alignItems: 'center', minHeight: 36, justifyContent: 'center',
    borderWidth: 1, borderColor: '#5C1010',
  },
  kickBtnText: { color: '#FF8080', fontSize: 12, fontWeight: '600' },
  emptyMembers: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyMembersText: { color: '#555555', fontSize: 13 },

  actionsDivider: {
    height: 1,
    backgroundColor: '#1C1C1C',
    marginBottom: 14,
  },
  actions: { paddingTop: 4, paddingBottom: 4 },

  // Discover view
  headerBack: { color: '#888888', fontSize: 14, fontWeight: '600' },
  discoverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 60,
  },
  discoverInfo: { flex: 1 },
  discoverName: { color: '#F0F0F0', fontSize: 15, fontWeight: '600' },
  discoverMeta: { color: '#555555', fontSize: 12, marginTop: 3 },
  discoverJoinBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  discoverJoinText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  // PTT channel management
  channelSection: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#2A2A2A' },
  channelRow: { flexDirection: 'row' },
  channelChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginRight: 8,
    minHeight: 34,
    justifyContent: 'center',
  },
  channelChipActive: { borderColor: '#DC143C', backgroundColor: '#1A0505' },
  channelChipText: { color: '#555555', fontSize: 12, fontWeight: '600' },
  channelChipTextActive: { color: '#DC143C' },
  channelNewChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderStyle: 'dashed',
    marginRight: 8,
    minHeight: 34,
    justifyContent: 'center',
  },
  channelNewText: { color: '#555555', fontSize: 12, fontWeight: '600' },
  newChannelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  newChannelInput: {
    flex: 1,
    marginBottom: 0,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  newChannelAdd: {
    backgroundColor: '#DC143C',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  newChannelAddText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  newChannelCancel: {
    backgroundColor: '#2A2A2A',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  newChannelCancelText: { color: '#888888', fontWeight: '600', fontSize: 14 },
});

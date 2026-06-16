/**
 * ConvoyScreen — group creation, joining, and management.
 * Requirements: 7.1–7.9, 8.4–8.5, 9.1–9.3, 15.4, 36.5, 36.6
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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

interface ConvoyGroup {
  id: string;
  name: string;
  joinCode: string;
  adminId: string;
  status: 'active' | 'ended';
  memberCount: number;
}

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

// ---------------------------------------------------------------------------
// ConvoyScreen
// ---------------------------------------------------------------------------

export default function ConvoyScreen({ userId }: Props) {
  const [group, setGroup] = useState<ConvoyGroup | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [groupName, setGroupName] = useState('');
  const [view, setView] = useState<'home' | 'create' | 'join'>('home');

  const isAdmin = group?.adminId === userId;

  // ── Create group (Req 7.1–7.3) ────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!groupName.trim()) return Alert.alert('Error', 'Enter a group name.');
    setLoading(true);
    try {
      const res = await apiClient.post<ConvoyGroup>('/api/v1/groups', { name: groupName.trim() });
      setGroup(res.data);
      setView('home');
      setGroupName('');
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
    } catch {
      Alert.alert('Error', 'Invalid join code or group not found.');
    } finally {
      setLoading(false);
    }
  }, [joinCode]);

  // ── Share join code (Req 7.3) ─────────────────────────────────────────────
  const handleShareCode = useCallback(async () => {
    if (!group) return;
    await Share.share({
      message: `Join my CONVOY group "${group.name}" with code: ${group.joinCode}\nhttps://convoy.app/join/${group.joinCode}`,
    });
  }, [group]);

  // ── Copy join code — shares the raw code string so the OS handles copy ──
  const handleCopyCode = useCallback(async () => {
    if (!group) return;
    await Share.share({ message: group.joinCode });
  }, [group]);

  // ── Leave group (Req 7.7) ─────────────────────────────────────────────────
  const handleLeave = useCallback(() => {
    Alert.alert('Leave Group', 'Are you sure you want to leave this convoy?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.post(`/api/v1/groups/${group!.id}/leave`);
            setGroup(null);
            setMembers([]);
          } catch {
            Alert.alert('Error', 'Could not leave group.');
          }
        },
      },
    ]);
  }, [group]);

  // ── End group (Admin only, Req 7.9) ──────────────────────────────────────
  const handleEnd = useCallback(() => {
    Alert.alert('End Convoy', 'This will end the session for all members.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Convoy',
        style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.post(`/api/v1/groups/${group!.id}/end`);
            setGroup(null);
            setMembers([]);
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
    try {
      await apiClient.post(`/api/v1/groups/${group.id}/members/${memberId}/mute`);
      setMembers((prev) =>
        prev.map((m) => (m.userId === memberId ? { ...m, isMuted: !m.isMuted } : m)),
      );
    } catch {
      Alert.alert('Error', 'Could not mute member.');
    }
  }, [group]);

  // ── Home: no group ────────────────────────────────────────────────────────
  if (!group) {
    if (view === 'create') {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Create Convoy</Text>
          <TextInput
            style={styles.input}
            placeholder="Group name"
            placeholderTextColor="#64748b"
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
        </View>
      );
    }

    if (view === 'join') {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Join Convoy</Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            placeholder="Enter 6-char code"
            placeholderTextColor="#64748b"
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
        </View>
      );
    }

    return (
      <View style={styles.container}>
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
        </View>
      </View>
    );
  }

  // ── Active group view ─────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
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
            <Text style={styles.copyBtnText}>Copy</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shareCodeBtn}
            onPress={handleShareCode}
            accessibilityLabel="Share join code"
          >
            <Text style={styles.shareCodeText}>Share</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.sectionLabel}>MEMBERS ({members.length})</Text>

      <FlatList
        data={members}
        keyExtractor={(m) => m.userId}
        style={styles.memberList}
        renderItem={({ item: m }) => (
          <View style={styles.memberRow}>
            {/* Online/offline dot */}
            <View style={[styles.statusDot, m.isOnline ? styles.dotOnline : styles.dotOffline]} />

            <View style={styles.memberInfo}>
              <Text style={styles.memberName}>{m.displayName}</Text>
              <View style={styles.memberMetaRow}>
                {m.speedKph != null && (
                  <Text style={styles.memberMeta}>💨 {m.speedKph.toFixed(0)} km/h</Text>
                )}
                {m.distanceM != null && (
                  <Text style={styles.memberMeta}>📍 {(m.distanceM / 1000).toFixed(1)} km behind</Text>
                )}
              </View>
            </View>

            {isAdmin && (
              <TouchableOpacity
                style={[styles.muteBtn, m.isMuted && styles.muteBtnActive]}
                onPress={() => void handleMute(m.userId)}
              >
                <Text style={styles.muteBtnText}>{m.isMuted ? 'Unmute' : 'Mute'}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
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
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 16 },

  // Header bar
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingTop: 4,
  },
  headerTitle: {
    color: '#f1f5f9',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 3,
  },
  memberCountBadge: {
    backgroundColor: '#3b82f6',
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

  title: { color: '#f1f5f9', fontSize: 24, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  subtitle: { color: '#64748b', fontSize: 14, marginBottom: 32, textAlign: 'center' },

  input: {
    backgroundColor: '#1e293b', color: '#f1f5f9', borderRadius: 10,
    padding: 14, fontSize: 16, marginBottom: 12,
    borderWidth: 1, borderColor: '#334155',
  },
  codeInput: { letterSpacing: 8, textAlign: 'center', fontSize: 22, fontWeight: '700', fontFamily: 'monospace' },

  primaryBtn: {
    backgroundColor: '#3b82f6', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10, minHeight: 52,
    justifyContent: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    backgroundColor: '#1e293b', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10, minHeight: 52,
    justifyContent: 'center', borderWidth: 1, borderColor: '#334155',
  },
  secondaryBtnText: { color: '#94a3b8', fontWeight: '600', fontSize: 15 },
  dangerBtn: {
    backgroundColor: '#7f1d1d', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10, minHeight: 52,
    justifyContent: 'center', borderWidth: 1, borderColor: '#b91c1c',
  },
  dangerBtnText: { color: '#fca5a5', fontWeight: '700', fontSize: 15 },

  // Group card
  groupCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  groupName: { color: '#f1f5f9', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  joinCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  joinCodeLabel: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  joinCodeValue: {
    color: '#3b82f6',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 4,
    fontFamily: 'monospace',
    flex: 1,
  },
  copyBtn: {
    backgroundColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  copyBtnText: { color: '#94a3b8', fontSize: 12, fontWeight: '600' },
  shareCodeBtn: {
    backgroundColor: '#1d4ed8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  shareCodeText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  sectionLabel: { color: '#64748b', fontSize: 11, fontWeight: '700', marginBottom: 8, letterSpacing: 1.5 },
  memberList: { flex: 1 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
    minHeight: 60,
    gap: 10,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotOnline: { backgroundColor: '#22c55e' },
  dotOffline: { backgroundColor: '#475569' },
  memberInfo: { flex: 1 },
  memberName: { color: '#e2e8f0', fontSize: 15, fontWeight: '600' },
  memberMetaRow: { flexDirection: 'row', gap: 10, marginTop: 3 },
  memberMeta: { color: '#64748b', fontSize: 12 },
  muteBtn: {
    backgroundColor: '#334155', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, minWidth: 64,
    alignItems: 'center', minHeight: 36, justifyContent: 'center',
  },
  muteBtnActive: { backgroundColor: '#7c3aed' },
  muteBtnText: { color: '#f1f5f9', fontSize: 12, fontWeight: '600' },
  emptyMembers: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyMembersText: { color: '#64748b', fontSize: 13 },

  actionsDivider: {
    height: 1,
    backgroundColor: '#1e293b',
    marginBottom: 14,
  },
  actions: { paddingTop: 4, paddingBottom: 4 },
});

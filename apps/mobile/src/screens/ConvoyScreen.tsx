/**
 * ConvoyScreen — group creation, joining, and management.
 * Requirements: 7.1–7.9, 8.4–8.5, 9.1–9.3, 15.4, 36.5, 36.6
 */

import React, { useCallback, useEffect, useState } from 'react';
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
        <Text style={styles.title}>Convoy</Text>
        <Text style={styles.subtitle}>Start or join a driving group</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => setView('create')}>
          <Text style={styles.primaryBtnText}>Create Group</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => setView('join')}>
          <Text style={styles.secondaryBtnText}>Join with Code</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Active group view ─────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.groupHeader}>
        <View>
          <Text style={styles.groupName}>{group.name}</Text>
          <Text style={styles.joinCode}>Code: {group.joinCode}</Text>
        </View>
        <TouchableOpacity style={styles.shareCodeBtn} onPress={handleShareCode}>
          <Text style={styles.shareCodeText}>Share</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionLabel}>Members ({members.length})</Text>
      <FlatList
        data={members}
        keyExtractor={(m) => m.userId}
        style={styles.memberList}
        renderItem={({ item: m }) => (
          <View style={styles.memberRow}>
            <View style={styles.memberInfo}>
              <Text style={styles.memberName}>{m.displayName}</Text>
              {m.speedKph != null && (
                <Text style={styles.memberMeta}>{m.speedKph.toFixed(0)} km/h</Text>
              )}
              {m.distanceM != null && (
                <Text style={styles.memberMeta}>{(m.distanceM / 1000).toFixed(1)} km behind</Text>
              )}
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
        ListEmptyComponent={<Text style={styles.emptyText}>Waiting for members to join…</Text>}
      />

      <View style={styles.actions}>
        {isAdmin && (
          <TouchableOpacity style={styles.dangerBtn} onPress={handleEnd}>
            <Text style={styles.dangerBtnText}>End Convoy</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.secondaryBtn} onPress={handleLeave}>
          <Text style={styles.secondaryBtnText}>Leave</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 20 },
  title: { color: '#f1f5f9', fontSize: 24, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#64748b', fontSize: 14, marginBottom: 32 },

  input: {
    backgroundColor: '#1e293b', color: '#f1f5f9', borderRadius: 10,
    padding: 14, fontSize: 16, marginBottom: 12,
    borderWidth: 1, borderColor: '#334155',
  },
  codeInput: { letterSpacing: 8, textAlign: 'center', fontSize: 22, fontWeight: '700' },

  primaryBtn: {
    backgroundColor: '#3b82f6', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginBottom: 10, minHeight: 50,
    justifyContent: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    backgroundColor: '#1e293b', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginBottom: 10, minHeight: 50,
    justifyContent: 'center', borderWidth: 1, borderColor: '#334155',
  },
  secondaryBtnText: { color: '#94a3b8', fontWeight: '600', fontSize: 15 },
  dangerBtn: {
    backgroundColor: '#7f1d1d', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginBottom: 10, minHeight: 50,
    justifyContent: 'center', borderWidth: 1, borderColor: '#ef4444',
  },
  dangerBtnText: { color: '#fca5a5', fontWeight: '700', fontSize: 15 },

  groupHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 20,
  },
  groupName: { color: '#f1f5f9', fontSize: 20, fontWeight: '700' },
  joinCode: { color: '#3b82f6', fontSize: 14, fontWeight: '600', marginTop: 4, letterSpacing: 2 },
  shareCodeBtn: {
    backgroundColor: '#1e293b', borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 8, borderWidth: 1, borderColor: '#334155',
    minHeight: 44, justifyContent: 'center',
  },
  shareCodeText: { color: '#3b82f6', fontWeight: '600', fontSize: 13 },

  sectionLabel: { color: '#64748b', fontSize: 12, fontWeight: '600', marginBottom: 8, letterSpacing: 1 },
  memberList: { flex: 1 },
  memberRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1e293b', borderRadius: 10, padding: 12,
    marginBottom: 6, borderWidth: 1, borderColor: '#334155',
    minHeight: 56,
  },
  memberInfo: { flex: 1 },
  memberName: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  memberMeta: { color: '#64748b', fontSize: 12, marginTop: 2 },
  muteBtn: {
    backgroundColor: '#334155', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, minWidth: 60,
    alignItems: 'center', minHeight: 36, justifyContent: 'center',
  },
  muteBtnActive: { backgroundColor: '#7c3aed' },
  muteBtnText: { color: '#f1f5f9', fontSize: 12, fontWeight: '600' },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 32, fontSize: 13 },

  actions: { paddingTop: 12 },
});

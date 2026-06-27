/**
 * ConvoyScreen — group creation, joining, and management.
 * Requirements: 7.1–7.9, 8.4–8.5, 9.1–9.3, 15.4, 36.5, 36.6
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
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
import * as Clipboard from 'expo-clipboard';
import * as ExpoLocation from 'expo-location';
import { router } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { haversineDistanceM } from '../services/DriveService';
import { useGroupStore } from '../stores/groupStore';
import { useSocketStore } from '../stores/socketStore';
import { useLocationStore } from '../stores/locationStore';
import { useMotionStore } from '../stores/motionStore';

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
  callsign: string | null;
  isGroupAdmin: boolean;
  vehicleType?: string;
}

// Initials from a display name (up to 2 chars)
function memberInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();
}

function getVehicleEmoji(vehicleType: string | undefined): string {
  const map: Record<string, string> = {
    car: '🚗',
    sports_car: '🏎️',
    suv: '🚙',
    truck: '🛻',
    motorcycle: '🏍️',
    van: '🚐',
    track_car: '🏎️',
  };
  return map[vehicleType?.toLowerCase() ?? ''] ?? '🚗';
}

function formatEventDate(scheduledFor: string): string {
  const d = new Date(scheduledFor);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Pulsing online indicator — uses Animated so it only runs for online members
function PulsingDot({ online }: { online: boolean }) {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!online) { anim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 0.2, duration: 900, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [online, anim]);
  return (
    <Animated.View
      style={[
        memberStyles.onlineDot,
        { backgroundColor: online ? '#22c55e' : '#444444' },
        online ? { opacity: anim } : {},
      ]}
    />
  );
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

  const [createGapThreshold, setCreateGapThreshold] = useState(1000);
  const [createAccessType, setCreateAccessType] = useState<'open' | 'invite_only'>('open');
  const [createNameFocused, setCreateNameFocused] = useState(false);

  const [publicGroups, setPublicGroups] = useState<ConvoyGroup[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCopyFeedback, setInviteCopyFeedback] = useState(false);
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inviteCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [upcomingEvent, setUpcomingEvent] = useState<{ id: string; title: string; scheduledFor: string } | null>(null);
  const [eventCountdown, setEventCountdown] = useState<{ hours: number; minutes: number; seconds: number } | null>(null);
  const [convoyStarting, setConvoyStarting] = useState(false);
  const [eventRsvp, setEventRsvp] = useState<{ going: number; maybe: number; notGoing: number; myStatus: string | null }>({ going: 0, maybe: 0, notGoing: 0, myStatus: null });

  const { socket } = useSocketStore();
  const { memberLocations } = useLocationStore();
  const isInMotion = useMotionStore((s) => s.isInMotion);

  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const setActiveGroupId = useGroupStore((s) => s.setActiveGroupId);
  const setPttChannelId = useGroupStore((s) => s.setPttChannelId);
  const setGroupMeta = useGroupStore((s) => s.setGroupMeta);
  const clearGroupMeta = useGroupStore((s) => s.clearGroupMeta);

  // Keep global group store in sync so map/other tabs can read group metadata
  useEffect(() => {
    setActiveGroupId(group?.id ?? null);
    if (group) {
      setGroupMeta({ name: group.name, memberCount: group.memberCount, adminId: group.adminId });
    } else {
      clearGroupMeta();
    }
  }, [group?.id, group?.name, group?.memberCount, group?.adminId, setActiveGroupId, setGroupMeta, clearGroupMeta]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
      if (inviteCopyTimer.current) clearTimeout(inviteCopyTimer.current);
    };
  }, []);

  // On mount: restore full group state when the root layout already resolved an
  // active group from GET /groups/active (happens after app restart).
  // By the time ConvoyScreen mounts, authStore.isLoading is false and
  // activeGroupId is stable — so [] dependency is intentional here.
  useEffect(() => {
    if (group !== null || !activeGroupId) return;
    setLoading(true);
    apiClient
      .get<ConvoyGroup>(`/api/v1/groups/${activeGroupId}`)
      .then((res) => { if (res.data.status === 'active') setGroup(res.data); })
      .catch(() => {}) // group ended or user no longer a member — leave as null
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Fetch upcoming event for the group
  useEffect(() => {
    if (!group) { setUpcomingEvent(null); setEventRsvp({ going: 0, maybe: 0, notGoing: 0, myStatus: null }); return; }
    apiClient.get<{ events: Array<{ id: string; title: string; scheduledFor: string }> }>(`/api/v1/groups/${group.id}/events`)
      .then(async (res) => {
        const ev = res.data.events[0] ?? null;
        setUpcomingEvent(ev);
        if (!ev) return;
        try {
          const rsvpRes = await apiClient.get<{ rsvps: Array<{ userId: string; status: string }> }>(
            `/api/v1/groups/${group.id}/events/${ev.id}/rsvps`
          );
          const rsvps = rsvpRes.data.rsvps ?? [];
          setEventRsvp({
            going: rsvps.filter((r) => r.status === 'going').length,
            maybe: rsvps.filter((r) => r.status === 'maybe').length,
            notGoing: rsvps.filter((r) => r.status === 'not_going').length,
            myStatus: rsvps.find((r) => r.userId === userId)?.status ?? null,
          });
        } catch { /* RSVP fetch is non-fatal */ }
      })
      .catch(() => {});
  }, [group?.id, userId]);

  // Update countdown every second
  useEffect(() => {
    if (!upcomingEvent) { setEventCountdown(null); setConvoyStarting(false); return; }
    const update = () => {
      const diffMs = new Date(upcomingEvent.scheduledFor).getTime() - Date.now();
      if (diffMs <= 0) {
        setEventCountdown(null);
        setConvoyStarting(true);
        return;
      }
      setConvoyStarting(false);
      setEventCountdown({
        hours: Math.floor(diffMs / 3600000),
        minutes: Math.floor((diffMs % 3600000) / 60000),
        seconds: Math.floor((diffMs % 60000) / 1000),
      });
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [upcomingEvent]);

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
          callsign: m.pttCallsign ?? null,
          isGroupAdmin: m.isAdmin,
          vehicleType: (m as unknown as { vehicleType?: string }).vehicleType,
        }));
        setMembers(normalised);
        setGroupMeta({ memberCount: res.data.members.length });
      })
      .catch(() => {/* silently fail – user will see empty list */});
  }, [setGroupMeta]);

  // ── Load members when group becomes non-null ──────────────────────────────
  useEffect(() => {
    if (!group) return;
    fetchMembers(group.id);
  }, [group?.id, fetchMembers]);

  // ── Socket: real-time group and member events ─────────────────────────────
  useEffect(() => {
    if (!socket || !group) return;
    const handleGroupEnded = () => { setGroup(null); setMembers([]); setView('home'); };
    const handleMemberJoined = () => { fetchMembers(group.id); };
    const handleMemberLeft = () => { fetchMembers(group.id); };
    const handleKicked = () => { setGroup(null); setMembers([]); setView('home'); };
    const handleSettingsUpdated = (data: { gapThresholdM?: number; pttMaxSeconds?: number }) => {
      setGroup((prev) => prev ? { ...prev, ...data } : null);
    };
    const handlePttMuted = () => {
      Alert.alert('Muted', 'The group admin has muted your PTT microphone.');
    };
    const handlePttUnmuted = () => {
      Alert.alert('Unmuted', 'The group admin has unmuted your PTT microphone.');
    };
    const handleMemberMuteChanged = () => { fetchMembers(group.id); };
    socket.on('group:ended', handleGroupEnded);
    socket.on('member:joined', handleMemberJoined);
    socket.on('member:left', handleMemberLeft);
    socket.on('member:kicked', handleKicked);
    socket.on('group:settings_updated', handleSettingsUpdated);
    socket.on('ptt:muted', handlePttMuted);
    socket.on('ptt:unmuted', handlePttUnmuted);
    socket.on('member:mute_changed', handleMemberMuteChanged);
    return () => {
      socket.off('group:ended', handleGroupEnded);
      socket.off('member:joined', handleMemberJoined);
      socket.off('member:left', handleMemberLeft);
      socket.off('member:kicked', handleKicked);
      socket.off('group:settings_updated', handleSettingsUpdated);
      socket.off('ptt:muted', handlePttMuted);
      socket.off('ptt:unmuted', handlePttUnmuted);
      socket.off('member:mute_changed', handleMemberMuteChanged);
    };
  }, [socket, group, fetchMembers]);

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
      const res = await apiClient.post<ConvoyGroup>('/api/v1/groups', { name: groupName.trim(), gapThresholdM: createGapThreshold, accessType: createAccessType });
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

  // Req 34 — block multi-step flows when in motion
  const guardInMotion = useCallback((): boolean => {
    if (!isInMotion) return false;
    Alert.alert('Park to continue', 'Please park before making group settings changes.');
    return true;
  }, [isInMotion]);

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
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      try {
        await Share.share({ message: `Join my convoy! Code: ${group.joinCode}` });
      } catch { /* user cancelled */ }
    }
  }, [group]);

  const handleInviteCopy = useCallback(async () => {
    if (!group) return;
    try {
      await Clipboard.setStringAsync(group.joinCode);
      setInviteCopyFeedback(true);
      if (inviteCopyTimer.current) clearTimeout(inviteCopyTimer.current);
      inviteCopyTimer.current = setTimeout(() => setInviteCopyFeedback(false), 2000);
    } catch { /* ignore */ }
  }, [group]);

  const handleInviteShare = useCallback(async () => {
    if (!group) return;
    try {
      await Share.share({
        message: `Join my CONVOY group "${group.name}" — use code: ${group.joinCode}\nhttps://convoy.app/join/${group.joinCode}`,
      });
    } catch { /* user cancelled */ }
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
            const memberCount = members.length;
            setGroup(null);
            setMembers([]);
            setView('home');
            router.push({
              pathname: '/convoy-end' as never,
              params: {
                groupName: currentGroup.name,
                memberCount: String(memberCount),
                durationMinutes: '0',
                distanceM: '0',
                adminName: 'You',
              },
            });
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

  // ── Kebab menu for admin actions per member ──────────────────────────────
  const handleMemberMenu = useCallback((m: GroupMember) => {
    Alert.alert(
      m.displayName,
      m.callsign ? `Callsign: ${m.callsign}` : undefined,
      [
        {
          text: m.isMuted ? '🔊 Unmute' : '🔇 Mute',
          onPress: () => { void handleMute(m.userId); },
        },
        {
          text: 'Remove from Convoy',
          style: 'destructive',
          onPress: () => { handleKick(m.userId); },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [handleMute, handleKick]);

  // ── Home: no group ────────────────────────────────────────────────────────
  if (!group) {
    if (view === 'create') {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.headerBar}>
            <Text style={styles.headerTitle}>CREATE CONVOY</Text>
            <TouchableOpacity onPress={() => setView('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={styles.headerBack}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.createFieldLabel}>GROUP NAME</Text>
            <View>
              <TextInput
                style={[styles.input, createNameFocused && styles.inputFocused]}
                placeholder="e.g. Sunday Rally"
                placeholderTextColor="#555555"
                value={groupName}
                onChangeText={setGroupName}
                onFocus={() => setCreateNameFocused(true)}
                onBlur={() => setCreateNameFocused(false)}
                autoFocus
                maxLength={50}
                accessibilityLabel="Group name"
              />
              <Text style={styles.charCounter}>{groupName.length}/50</Text>
            </View>

            <Text style={styles.createFieldLabel}>GAP ALERT DISTANCE</Text>
            <View style={styles.pillRow}>
              {GAP_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.createPill, createGapThreshold === opt.value && styles.createPillActive]}
                  onPress={() => setCreateGapThreshold(opt.value)}
                  accessibilityRole="button"
                  accessibilityLabel={`Gap threshold ${opt.label}`}
                  accessibilityState={{ selected: createGapThreshold === opt.value }}
                >
                  <Text style={[styles.createPillText, createGapThreshold === opt.value && styles.createPillTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.createFieldLabel}>ACCESS TYPE</Text>
            <View style={[styles.pillRow, { marginBottom: 24 }]}>
              {(['open', 'invite_only'] as const).map((type) => (
                <TouchableOpacity
                  key={type}
                  style={[styles.createPill, { flex: 1 }, createAccessType === type && styles.createPillActive]}
                  onPress={() => setCreateAccessType(type)}
                  accessibilityRole="button"
                  accessibilityLabel={type === 'open' ? 'Open access' : 'Invite only'}
                  accessibilityState={{ selected: createAccessType === type }}
                >
                  <Text style={[styles.createPillText, createAccessType === type && styles.createPillTextActive]}>
                    {type === 'open' ? '🌐  Open' : '🔒  Invite Only'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <TouchableOpacity
            style={[styles.primaryBtn, { minHeight: 56 }, (!groupName.trim() || loading) && { opacity: 0.4 }]}
            onPress={handleCreate}
            disabled={!groupName.trim() || loading}
            accessibilityRole="button"
            accessibilityLabel="Create convoy"
            accessibilityState={{ disabled: !groupName.trim() || loading }}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Create Convoy</Text>}
          </TouchableOpacity>
        </SafeAreaView>
      );
    }

    if (view === 'join') {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.headerBar}>
            <Text style={styles.headerTitle}>JOIN CONVOY</Text>
            <TouchableOpacity onPress={() => setView('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={styles.headerBack}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.createFieldLabel}>ENTER INVITE CODE</Text>
          <View style={styles.codeInputRow}>
            <TextInput
              style={[styles.input, styles.codeInput, { flex: 1, marginBottom: 0 }]}
              placeholder="XXXXXX"
              placeholderTextColor="#333333"
              value={joinCode}
              onChangeText={(t) => {
                const upper = t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                setJoinCode(upper);
              }}
              autoCapitalize="characters"
              maxLength={6}
              autoFocus
              accessibilityLabel="6-character invite code"
            />
            <TouchableOpacity
              style={styles.pasteBtn}
              onPress={async () => {
                const text = await Clipboard.getStringAsync();
                const upper = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                setJoinCode(upper);
              }}
              accessibilityRole="button"
              accessibilityLabel="Paste code from clipboard"
            >
              <Text style={styles.pasteBtnText}>📋 Paste</Text>
            </TouchableOpacity>
          </View>
          {joinCode.length > 0 && (
            <Text style={styles.codePreviewText}>Code: {joinCode}</Text>
          )}

          <TouchableOpacity
            style={[styles.primaryBtn, { minHeight: 56, marginTop: 24 }, (joinCode.trim().length !== 6 || loading) && { opacity: 0.4 }]}
            onPress={handleJoin}
            disabled={joinCode.trim().length !== 6 || loading}
            accessibilityRole="button"
            accessibilityLabel="Join convoy"
            accessibilityState={{ disabled: joinCode.trim().length !== 6 || loading }}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Join Convoy</Text>}
          </TouchableOpacity>
        </SafeAreaView>
      );
    }

    if (view === 'discover') {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.headerBar}>
            <Text style={styles.headerTitle}>DISCOVER</Text>
            <TouchableOpacity onPress={() => setView('home')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Go back">
              <Text style={styles.headerBack}>← Back</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.secondaryBtn, { marginBottom: 16 }]}
            onPress={fetchPublicGroups}
            disabled={discoverLoading}
            accessibilityRole="button"
            accessibilityLabel="Refresh convoy list"
            accessibilityState={{ disabled: discoverLoading }}
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
                  accessibilityRole="button"
                  accessibilityLabel={`Join convoy: ${g.name}`}
                  accessibilityState={{ disabled: loading }}
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
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setView('create')} accessibilityRole="button" accessibilityLabel="Create a new convoy group">
            <Text style={styles.primaryBtnText}>Create Group</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setView('join')} accessibilityRole="button" accessibilityLabel="Join a convoy with a code">
            <Text style={styles.secondaryBtnText}>Join with Code</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => { setView('discover'); void fetchPublicGroups(); }}
            accessibilityRole="button"
            accessibilityLabel="Browse open convoys"
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={styles.memberCountBadge}>
            <Text style={styles.memberCountText}>{members.length} RIDERS</Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/group-chat' as never, params: { groupId: activeGroupId } })}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Group chat"
          >
            <Text style={{ fontSize: 20 }}>💬</Text>
          </TouchableOpacity>
          {isAdmin && (
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/group-settings' as never, params: { groupId: group.id, isAdmin: 'true' } })}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Group settings"
            >
              <Text style={{ fontSize: 20 }}>⚙️</Text>
            </TouchableOpacity>
          )}
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
            accessibilityRole="button"
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
            accessibilityRole="button"
            accessibilityLabel="Share join code"
          >
            <Text style={styles.shareCodeText}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.qrBtn}
            onPress={() => setShowQR(true)}
            accessibilityRole="button"
            accessibilityLabel="Show QR code for join link"
          >
            <Text style={styles.qrBtnText}>QR</Text>
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
                  onPress={() => { if (!guardInMotion()) void handleSetGapThreshold(opt.value); }}
                  accessibilityRole="button"
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
            {pttChannels.map((ch) => {
              const isActive = activePttChannelId === ch.id;
              return (
                <TouchableOpacity
                  key={ch.id}
                  style={[styles.channelListRow, isActive && styles.channelListRowActive]}
                  onPress={() => void handleJoinChannel(ch.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`PTT Channel: ${ch.isAll ? 'All Members' : ch.name}`}
                  accessibilityState={{ checked: isActive }}
                >
                  <View style={[styles.channelListStrip, isActive && styles.channelListStripActive]} />
                  <Text style={[styles.channelListName, isActive && styles.channelListNameActive]}>
                    {ch.isAll ? '📢  All Members' : `# ${ch.name}`}
                  </Text>
                  {typeof ch.memberCount === 'number' && (
                    <Text style={styles.channelMemberCount}>{ch.memberCount} online</Text>
                  )}
                  <View style={[styles.channelRadio, isActive && styles.channelRadioActive]}>
                    {isActive && <View style={styles.channelRadioDot} />}
                  </View>
                </TouchableOpacity>
              );
            })}
            {isAdmin && !showNewChannel && (
              <TouchableOpacity
                style={styles.channelAddRow}
                onPress={() => { if (!guardInMotion()) setShowNewChannel(true); }}
                accessibilityRole="button"
                accessibilityLabel="Create new PTT channel"
              >
                <Text style={styles.channelAddText}>+ Add Channel</Text>
              </TouchableOpacity>
            )}
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
                  accessibilityRole="button"
                  accessibilityLabel="Add PTT channel"
                >
                  <Text style={styles.newChannelAddText}>Add</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.newChannelCancel}
                  onPress={() => { setShowNewChannel(false); setNewChannelName(''); }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel new channel"
                >
                  <Text style={styles.newChannelCancelText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Convoy starting banner */}
      {convoyStarting && (
        <View style={styles.startingBanner}>
          <Text style={styles.startingBannerText}>🏁 Convoy starting!</Text>
        </View>
      )}

      {/* Upcoming event card */}
      {upcomingEvent && (
        <TouchableOpacity
          style={styles.eventCard}
          onPress={() => router.push({ pathname: '/event/[id]' as never, params: { id: upcomingEvent.id } })}
          accessibilityRole="button"
          accessibilityLabel={`Event: ${upcomingEvent.title}. Tap for details.`}
        >
          <View style={styles.eventStrip} />
          <View style={{ flex: 1, padding: 12 }}>
            <Text style={styles.eventTitle}>📅 {upcomingEvent.title}</Text>
            <Text style={styles.eventDate}>{formatEventDate(upcomingEvent.scheduledFor)}</Text>

            {/* RSVP summary */}
            <Text style={styles.eventRsvpSummary}>
              {eventRsvp.going > 0 ? `✅ ${eventRsvp.going} going` : ''}
              {eventRsvp.maybe > 0 ? `  🤔 ${eventRsvp.maybe} maybe` : ''}
              {(eventRsvp.going === 0 && eventRsvp.maybe === 0) ? 'No RSVPs yet' : ''}
            </Text>

            {/* User RSVP status + action */}
            <View style={styles.eventRsvpRow}>
              {eventRsvp.myStatus === 'going' ? (
                <Text style={styles.eventRsvpGoing}>✅ You're going</Text>
              ) : eventRsvp.myStatus === 'maybe' ? (
                <Text style={styles.eventRsvpMaybe}>🤔 You're maybe going</Text>
              ) : (
                <Text style={styles.eventRsvpCta}>Tap to RSVP →</Text>
              )}
              <Text style={styles.eventViewDetails}>View Details ›</Text>
            </View>

            {/* Countdown if event is soon */}
            {eventCountdown && (
              <View style={styles.countdownRow}>
                {[
                  { value: eventCountdown.hours, label: 'HH' },
                  { value: eventCountdown.minutes, label: 'MM' },
                  { value: eventCountdown.seconds, label: 'SS' },
                ].map((unit, i) => {
                  const isUrgent = eventCountdown.hours < 1;
                  return (
                    <React.Fragment key={unit.label}>
                      {i > 0 && <Text style={[styles.countdownColon, isUrgent && styles.countdownColonUrgent]}>:</Text>}
                      <Text style={[styles.countdownNum, isUrgent && styles.countdownNumUrgent]}>
                        {String(unit.value).padStart(2, '0')}
                      </Text>
                    </React.Fragment>
                  );
                })}
              </View>
            )}
          </View>
        </TouchableOpacity>
      )}

      {/* Schedule event — admin only */}
      {isAdmin && (
        <TouchableOpacity
          style={styles.scheduleBtn}
          onPress={() => router.push({ pathname: '/create-event' as never, params: { groupId: group.id } })}
          accessibilityRole="button"
          accessibilityLabel="Schedule a convoy event"
        >
          <Text style={styles.scheduleBtnText}>📅  Schedule Event</Text>
        </TouchableOpacity>
      )}

      {/* Quick action row — Invite + Leaderboard */}
      <View style={styles.quickActions}>
        <TouchableOpacity
          style={styles.quickActionBtn}
          onPress={() => setShowInvite(true)}
          accessibilityRole="button"
          accessibilityLabel="Invite friends to this convoy"
        >
          <Text style={styles.quickActionIcon}>📨</Text>
          <Text style={styles.quickActionText}>Invite</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.quickActionBtn}
          onPress={() => router.push({ pathname: '/leaderboard' as never, params: { groupId: group.id, groupName: group.name } })}
          accessibilityRole="button"
          accessibilityLabel="View group leaderboard"
        >
          <Text style={styles.quickActionIcon}>🏆</Text>
          <Text style={styles.quickActionText}>Leaderboard</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.quickActionBtn}
          onPress={() => router.push({ pathname: '/waypoints' as never, params: { groupId: group.id } })}
          accessibilityRole="button"
          accessibilityLabel="Manage waypoints"
        >
          <Text style={styles.quickActionIcon}>📍</Text>
          <Text style={styles.quickActionText}>Waypoints</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionLabel}>MEMBERS ({members.length})</Text>

      <FlatList
        data={[...members].sort((a, b) => {
          // Admin always first
          if (a.userId === group.adminId) return -1;
          if (b.userId === group.adminId) return 1;
          // Then online members
          const aOnline = !!memberLocations[a.userId];
          const bOnline = !!memberLocations[b.userId];
          if (aOnline && !bOnline) return -1;
          if (!aOnline && bOnline) return 1;
          return 0;
        })}
        keyExtractor={(m) => m.userId}
        style={styles.memberList}
        renderItem={({ item: m }) => {
          const mLoc = memberLocations[m.userId];
          const adminLoc = memberLocations[group.adminId];
          const distFromLead = mLoc && adminLoc && m.userId !== group.adminId
            ? haversineDistanceM(adminLoc.lat, adminLoc.lng, mLoc.lat, mLoc.lng)
            : null;
          const isLive = !!memberLocations[m.userId];
          const memberIsAdmin = m.userId === group.adminId;
          const avatarBg = memberIsAdmin ? '#2A0A0A' : '#1C1C1C';
          const avatarText = memberIsAdmin ? '#DC143C' : '#888888';
          const distanceStr = distFromLead != null
            ? `${distFromLead >= 1000 ? `${(distFromLead / 1000).toFixed(1)} km` : `${Math.round(distFromLead)} m`} away`
            : '';
          return (
            <View
              style={memberStyles.row}
              accessible={true}
              accessibilityLabel={`${m.callsign ?? m.displayName}${distanceStr ? `, ${distanceStr}` : ''}`}
            >
              {/* Initials avatar */}
              <View style={[memberStyles.avatar, { backgroundColor: avatarBg }]}>
                <Text style={[memberStyles.avatarText, { color: avatarText }]}>
                  {memberInitials(m.displayName)}
                </Text>
              </View>

              {/* Name + callsign */}
              <View
                style={memberStyles.info}
                accessible={true}
                accessibilityLabel={`${m.displayName}${m.callsign ? ` ${m.callsign}` : ''}, ${isLive ? 'online' : 'offline'}`}
              >
                <View style={memberStyles.nameRow}>
                  <Text style={memberStyles.vehicleEmoji}>{getVehicleEmoji(m.vehicleType)}</Text>
                  <Text style={memberStyles.name}>{m.displayName}</Text>
                  {memberIsAdmin && <Text style={memberStyles.adminBadge}>ADMIN</Text>}
                  {m.isMuted && <Text style={memberStyles.mutedIcon}>🔇</Text>}
                </View>
                {m.callsign ? (
                  <Text style={memberStyles.callsign}>{m.callsign}</Text>
                ) : mLoc ? (
                  <Text style={memberStyles.callsign}>💨 {mLoc.speedKph.toFixed(0)} km/h</Text>
                ) : null}
              </View>

              {/* Right side: distance badge + online dot */}
              <View style={memberStyles.right}>
                {distFromLead != null && (
                  <View style={memberStyles.distancePill}>
                    <Text style={memberStyles.distanceText}>
                      {distFromLead >= 1000
                        ? `${(distFromLead / 1000).toFixed(1)} km`
                        : `${Math.round(distFromLead)} m`}
                    </Text>
                  </View>
                )}
                <PulsingDot online={isLive} />
              </View>

              {/* Admin kebab menu */}
              {isAdmin && m.userId !== userId && (
                <TouchableOpacity
                  style={memberStyles.kebab}
                  onPress={() => handleMemberMenu(m)}
                  accessibilityRole="button"
                  accessibilityLabel={`Options for ${m.displayName}`}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={memberStyles.kebabText}>•••</Text>
                </TouchableOpacity>
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
          <TouchableOpacity style={styles.dangerBtn} onPress={handleEnd} accessibilityRole="button" accessibilityLabel="End convoy">
            <Text style={styles.dangerBtnText}>🛑  End Convoy</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.secondaryBtn} onPress={handleLeave} accessibilityRole="button" accessibilityLabel="Leave convoy">
          <Text style={styles.secondaryBtnText}>Leave Convoy</Text>
        </TouchableOpacity>
      </View>

      {/* Invite Friends modal */}
      <Modal
        visible={showInvite}
        transparent
        animationType="slide"
        onRequestClose={() => setShowInvite(false)}
        accessibilityViewIsModal
      >
        <TouchableOpacity
          style={styles.qrOverlay}
          activeOpacity={1}
          onPress={() => setShowInvite(false)}
          accessibilityRole="button"
          accessibilityLabel="Close invite modal"
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View style={styles.inviteModal}>
              <View style={styles.inviteModalHandle} />
              <Text style={styles.inviteModalTitle}>📨 Invite Friends</Text>
              <Text style={styles.inviteModalGroupName}>{group?.name}</Text>
              <Text style={styles.inviteModalHint}>Share this code to invite riders</Text>

              <View style={styles.inviteCodeBox}>
                <Text style={styles.inviteCodeText} accessibilityLabel={`Join code: ${group?.joinCode ?? ''}`}>
                  {group?.joinCode ?? '------'}
                </Text>
              </View>

              <View style={styles.inviteActions}>
                <TouchableOpacity
                  style={[styles.inviteCopyBtn, inviteCopyFeedback && styles.inviteCopyBtnSuccess]}
                  onPress={() => void handleInviteCopy()}
                  accessibilityRole="button"
                  accessibilityLabel="Copy join code"
                >
                  <Text style={styles.inviteCopyBtnText}>
                    {inviteCopyFeedback ? '✓ Copied!' : '📋 Copy Code'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.inviteShareBtn}
                  onPress={() => void handleInviteShare()}
                  accessibilityRole="button"
                  accessibilityLabel="Share join code via share sheet"
                >
                  <Text style={styles.inviteShareBtnText}>↑ Share</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.inviteQrLink}
                onPress={() => { setShowInvite(false); setShowQR(true); }}
                accessibilityRole="button"
                accessibilityLabel="Show QR code"
              >
                <Text style={styles.inviteQrLinkText}>Show QR Code instead</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* QR code modal (Req 7.3) */}
      <Modal
        visible={showQR}
        transparent
        animationType="fade"
        onRequestClose={() => setShowQR(false)}
        accessibilityViewIsModal
      >
        <TouchableOpacity
          style={styles.qrOverlay}
          activeOpacity={1}
          onPress={() => setShowQR(false)}
          accessibilityRole="button"
          accessibilityLabel="Close QR code"
        >
          <View style={styles.qrCard}>
            <Text style={styles.qrTitle}>Scan to Join</Text>
            <Text style={styles.qrSubtitle}>{group?.name}</Text>
            <Image
              style={styles.qrImage}
              source={{
                uri: `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
                  `https://convoy.app/join/${group?.joinCode ?? ''}`,
                )}`,
              }}
              accessibilityLabel={`QR code for join code ${group?.joinCode ?? ''}`}
            />
            <Text style={styles.qrCodeLabel}>{group?.joinCode}</Text>
            <Text style={styles.qrDismiss}>Tap anywhere to close</Text>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Member row styles (separate sheet to avoid clashing with legacy styles)
// ---------------------------------------------------------------------------

const memberStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 64,
    gap: 10,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  info: {
    flex: 1,
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  name: {
    color: '#F0F0F0',
    fontSize: 16,
    fontWeight: '700',
  },
  adminBadge: {
    color: '#DC143C',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    backgroundColor: '#1A0505',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  mutedIcon: {
    fontSize: 13,
  },
  vehicleEmoji: {
    fontSize: 14,
    marginRight: 4,
  },
  callsign: {
    color: '#555555',
    fontSize: 13,
    marginTop: 2,
  },
  right: {
    alignItems: 'flex-end',
    gap: 6,
    flexShrink: 0,
  },
  distancePill: {
    backgroundColor: '#0A0A0A',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  distanceText: {
    color: '#888888',
    fontSize: 11,
    fontWeight: '600',
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  kebab: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexShrink: 0,
  },
  kebabText: {
    color: '#555555',
    fontSize: 16,
    letterSpacing: -1,
  },
});

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
  qrBtn: {
    borderWidth: 1,
    borderColor: '#DC143C',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  qrBtnText: { color: '#DC143C', fontWeight: '700', fontSize: 12 },

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
  qrSubtitle: { color: '#888', fontSize: 13, marginBottom: 16 },
  qrImage: { width: 240, height: 240, borderRadius: 8, marginBottom: 12 },
  qrCodeLabel: { color: '#DC143C', fontSize: 20, fontWeight: '800', letterSpacing: 4, marginBottom: 8 },
  qrDismiss: { color: '#555', fontSize: 11 },

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

  // Create form
  createFieldLabel: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8, marginTop: 20 },
  inputFocused: { borderColor: '#DC143C' },
  charCounter: { color: '#444444', fontSize: 11, textAlign: 'right', marginTop: 4, marginBottom: 4 },
  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  createPill: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    backgroundColor: '#1C1C1C', borderWidth: 1, borderColor: '#2A2A2A',
    alignItems: 'center', justifyContent: 'center',
  },
  createPillActive: { backgroundColor: '#1A0505', borderColor: '#DC143C' },
  createPillText: { color: '#555555', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  createPillTextActive: { color: '#DC143C' },

  // Join form
  codeInputRow: { flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 8 },
  pasteBtn: {
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#1C1C1C',
    borderRadius: 10, borderWidth: 1, borderColor: '#2A2A2A', justifyContent: 'center',
  },
  pasteBtnText: { color: '#888888', fontSize: 13, fontWeight: '600' },
  codePreviewText: { color: '#444444', fontSize: 13, textAlign: 'center', letterSpacing: 4, fontVariant: ['tabular-nums'] as any },

  // PTT vertical channel list
  channelListRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingRight: 12,
    borderLeftWidth: 4, borderLeftColor: 'transparent', marginBottom: 4, borderRadius: 0,
  },
  channelListRowActive: { backgroundColor: '#1A0505', borderLeftColor: '#DC143C' },
  channelListStrip: { width: 0 },
  channelListStripActive: { width: 0 },
  channelListName: { flex: 1, color: '#888888', fontSize: 14, fontWeight: '600', paddingLeft: 10 },
  channelListNameActive: { color: '#DC143C' },
  channelMemberCount: { color: '#444444', fontSize: 12, marginRight: 10 },
  channelRadio: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 2, borderColor: '#2A2A2A',
    alignItems: 'center', justifyContent: 'center',
  },
  channelRadioActive: { borderColor: '#DC143C' },
  channelRadioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#DC143C' },
  channelAddRow: { paddingVertical: 10, paddingLeft: 14, marginTop: 2 },
  channelAddText: { color: '#555555', fontSize: 13, fontWeight: '600' },

  // Upcoming event
  eventCard: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    overflow: 'hidden',
  },
  eventStrip: { width: 4, backgroundColor: '#F59E0B' },
  eventTitle: { color: '#F0F0F0', fontSize: 14, fontWeight: '700', marginBottom: 2 },
  eventDate: { color: '#888888', fontSize: 12, marginBottom: 6 },
  eventRsvpSummary: { color: '#888888', fontSize: 12, marginBottom: 4 },
  eventRsvpRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  eventRsvpGoing: { color: '#22C55E', fontSize: 12, fontWeight: '600' },
  eventRsvpMaybe: { color: '#F59E0B', fontSize: 12, fontWeight: '600' },
  eventRsvpCta: { color: '#DC143C', fontSize: 12, fontWeight: '600' },
  eventViewDetails: { color: '#555555', fontSize: 11 },
  eventCountdownLabel: { color: '#888888', fontSize: 11, marginBottom: 4 },
  countdownRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  countdownNum: {
    color: '#F0F0F0',
    fontSize: 32,
    fontWeight: '700',
    fontVariant: ['tabular-nums'] as any,
    minWidth: 44,
    textAlign: 'center',
  },
  countdownNumUrgent: { color: '#DC143C' },
  countdownColon: { color: '#888888', fontSize: 20, fontWeight: '700', marginHorizontal: 2 },
  countdownColonUrgent: { color: '#DC143C' },
  startingBanner: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  startingBannerText: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 1 },

  // Schedule event button
  scheduleBtn: {
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignSelf: 'flex-start',
  },
  scheduleBtnText: { color: '#888888', fontSize: 13, fontWeight: '600' },

  // Quick action row
  quickActions: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  quickActionBtn: {
    flex: 1,
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 60,
    gap: 4,
  },
  quickActionIcon: { fontSize: 20 },
  quickActionText: { color: '#888888', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  // Invite modal
  inviteModal: {
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderRadius: 20,
    padding: 24,
    width: 340,
    alignItems: 'center',
  },
  inviteModalHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#2A2A2A',
    borderRadius: 2,
    marginBottom: 20,
  },
  inviteModalTitle: {
    color: '#F0F0F0',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 4,
    textAlign: 'center',
  },
  inviteModalGroupName: {
    color: '#DC143C',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
    textAlign: 'center',
  },
  inviteModalHint: {
    color: '#555555',
    fontSize: 12,
    marginBottom: 20,
    textAlign: 'center',
  },
  inviteCodeBox: {
    backgroundColor: '#0A0A0A',
    borderRadius: 14,
    paddingVertical: 20,
    paddingHorizontal: 32,
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#DC143C',
    width: '100%',
    alignItems: 'center',
  },
  inviteCodeText: {
    color: '#DC143C',
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: 10,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  inviteActions: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginBottom: 14,
  },
  inviteCopyBtn: {
    flex: 1,
    backgroundColor: '#2A2A2A',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  inviteCopyBtnSuccess: { backgroundColor: '#14532D', borderWidth: 1, borderColor: '#22C55E' },
  inviteCopyBtnText: { color: '#F0F0F0', fontWeight: '700', fontSize: 14 },
  inviteShareBtn: {
    flex: 1,
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  inviteShareBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  inviteQrLink: { paddingVertical: 8 },
  inviteQrLinkText: { color: '#555555', fontSize: 13, textDecorationLine: 'underline' },
});

/**
 * ConvoyLobbyScreen — pre-drive waiting room where members gather before a convoy starts.
 * The leader sees a "Start Convoy" button; members see an "I'm Ready" toggle.
 * Three staggered radar-pulse rings animate behind the member list header.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { useAuthStore } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';
import { useSocketStore } from '../stores/socketStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LobbyMember {
  userId: string;
  displayName: string;
  callsign: string | null;
  isReady: boolean;
}

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
// Helpers
// ---------------------------------------------------------------------------

function memberInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// RadarRing — single pulsing radar ring (scale 1→2, opacity 1→0, loops)
// ---------------------------------------------------------------------------

const RING_SIZE = 80;

function RadarRing({ delay }: { delay: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    anim.setValue(0);
    // Use setTimeout for the initial stagger so the loop itself
    // runs at a consistent 1600 ms period without embedding the delay.
    const timer = setTimeout(() => {
      loopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 1,
            duration: 1600,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );
      loopRef.current.start();
    }, delay);

    return () => {
      clearTimeout(timer);
      loopRef.current?.stop();
    };
  }, [anim, delay]);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 2] });
  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  return (
    <Animated.View
      style={[radarStyles.ring, { transform: [{ scale }], opacity }]}
    />
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  groupId: string;
  groupName: string;
  onConvoyStart?: () => void;
}

// ---------------------------------------------------------------------------
// ConvoyLobbyScreen
// ---------------------------------------------------------------------------

export default function ConvoyLobbyScreen({ groupId, groupName, onConvoyStart }: Props) {
  const [members, setMembers] = useState<LobbyMember[]>([]);
  const [selfReady, setSelfReady] = useState(false);

  const user = useAuthStore((s) => s.user);
  const adminId = useGroupStore((s) => s.adminId);
  const { socket } = useSocketStore();

  const isLeader = !!user && !!adminId && user.id === adminId;

  // -- "Waiting for everyone to join..." pulsing label ----------------------
  const waitingOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(waitingOpacity, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(waitingOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [waitingOpacity]);

  // -- Fetch member list ----------------------------------------------------
  const fetchMembers = useCallback(() => {
    apiClient
      .get<{ members: MemberApiItem[] }>(`/api/v1/groups/${groupId}/members`)
      .then((res) => {
        setMembers((prev) => {
          // Preserve existing ready flags when refreshing the list
          const readySet = new Set(prev.filter((m) => m.isReady).map((m) => m.userId));
          return res.data.members.map((m) => ({
            userId: m.userId,
            displayName: m.displayName ?? '',
            callsign: m.pttCallsign ?? null,
            isReady: readySet.has(m.userId),
          }));
        });
      })
      .catch(() => {});
  }, [groupId]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  // -- Socket event listeners -----------------------------------------------
  useEffect(() => {
    if (!socket) return;

    const handleMemberReady = ({ userId }: { userId: string }) => {
      setMembers((prev) =>
        prev.map((m) => (m.userId === userId ? { ...m, isReady: true } : m)),
      );
    };

    const handleConvoyStart = () => {
      onConvoyStart?.();
    };

    const handleMemberJoined = () => {
      fetchMembers();
    };

    const handleMemberLeft = () => {
      fetchMembers();
    };

    socket.on('convoy:member_ready', handleMemberReady);
    socket.on('convoy:started', handleConvoyStart);
    socket.on('member:joined', handleMemberJoined);
    socket.on('member:left', handleMemberLeft);

    return () => {
      socket.off('convoy:member_ready', handleMemberReady);
      socket.off('convoy:started', handleConvoyStart);
      socket.off('member:joined', handleMemberJoined);
      socket.off('member:left', handleMemberLeft);
    };
  }, [socket, fetchMembers, onConvoyStart]);

  // -- Actions --------------------------------------------------------------
  const handleToggleReady = useCallback(() => {
    if (!user || !socket || selfReady) return; // ready is a one-way latch
    setSelfReady(true);
    // Optimistically mark self ready in the list
    setMembers((prev) =>
      prev.map((m) => (m.userId === user.id ? { ...m, isReady: true } : m)),
    );
    socket.emit('convoy:member_ready', { userId: user.id, groupId });
  }, [user, socket, selfReady, groupId]);

  const handleStartConvoy = useCallback(() => {
    if (!socket) return;
    socket.emit('convoy:start', { groupId });
    onConvoyStart?.();
  }, [socket, groupId, onConvoyStart]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Convoy Lobby</Text>
        {/* Spacer so title stays centred */}
        <View style={styles.headerSpacer} />
      </View>

      {/* ── Group name ── */}
      <Text style={styles.groupName} numberOfLines={1}>
        {groupName}
      </Text>

      {/* ── Pulsing waiting label ── */}
      <Animated.Text style={[styles.waitingLabel, { opacity: waitingOpacity }]}>
        Waiting for everyone to join...
      </Animated.Text>

      {/* ── Scrollable body ── */}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Radar pulse section (3 staggered rings behind MEMBERS label) ── */}
        <View style={styles.radarSection}>
          <View style={styles.radarRings} pointerEvents="none">
            <RadarRing delay={0} />
            <RadarRing delay={400} />
            <RadarRing delay={800} />
          </View>
          <Text style={styles.membersSectionLabel}>
            MEMBERS ({members.length})
          </Text>
        </View>

        {/* ── Member rows ── */}
        {members.map((m) => (
          <View
            key={m.userId}
            style={styles.memberRow}
            accessible
            accessibilityLabel={`${m.displayName}${m.callsign ? `, ${m.callsign}` : ''}, ${m.isReady ? 'ready' : 'waiting'}`}
          >
            {/* Avatar circle — crimson background with white initials */}
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{memberInitials(m.displayName)}</Text>
            </View>

            {/* Name + callsign */}
            <View style={styles.memberInfo}>
              <Text style={styles.memberName}>{m.displayName}</Text>
              {m.callsign ? (
                <Text style={styles.memberCallsign}>{m.callsign}</Text>
              ) : null}
            </View>

            {/* Status badge */}
            <View
              style={[
                styles.statusBadge,
                m.isReady ? styles.statusBadgeReady : styles.statusBadgeWaiting,
              ]}
            >
              <Text
                style={[
                  styles.statusBadgeText,
                  m.isReady
                    ? styles.statusBadgeTextReady
                    : styles.statusBadgeTextWaiting,
                ]}
              >
                {m.isReady ? 'Ready ✓' : 'Waiting…'}
              </Text>
            </View>
          </View>
        ))}

        {members.length === 0 && (
          <View style={styles.emptyMembers}>
            <Text style={styles.emptyMembersText}>No members yet…</Text>
          </View>
        )}
      </ScrollView>

      {/* ── Bottom sticky bar ── */}
      <View style={styles.stickyBar}>
        {isLeader ? (
          <TouchableOpacity
            style={styles.startBtn}
            onPress={handleStartConvoy}
            accessibilityRole="button"
            accessibilityLabel="Start convoy"
          >
            <Text style={styles.startBtnText}>Start Convoy</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.readyBtn, selfReady && styles.readyBtnActive]}
            onPress={handleToggleReady}
            disabled={selfReady}
            accessibilityRole="button"
            accessibilityLabel={selfReady ? "You are ready" : "Mark yourself as ready"}
            accessibilityState={{ selected: selfReady }}
          >
            <Text style={styles.readyBtnText}>
              {selfReady ? "I'm Ready ✓" : "I'm Ready"}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Radar ring styles
// ---------------------------------------------------------------------------

const radarStyles = StyleSheet.create({
  ring: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 1.5,
    borderColor: '#DC143C',
  },
});

// ---------------------------------------------------------------------------
// Screen styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  backArrow: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '600',
    width: 32,
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 32,
  },

  // Group name + waiting label
  groupName: {
    color: '#DC143C',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  waitingLabel: {
    color: '#888888',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },

  // Scroll body
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },

  // Radar section
  radarSection: {
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    overflow: 'hidden',
  },
  radarRings: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  membersSectionLabel: {
    color: '#888888',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    zIndex: 1,
  },

  // Member row
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 64,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  memberInfo: {
    flex: 1,
  },
  memberName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  memberCallsign: {
    color: '#888888',
    fontSize: 12,
    marginTop: 2,
  },

  // Status badge
  statusBadge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minWidth: 80,
    alignItems: 'center',
    flexShrink: 0,
  },
  statusBadgeReady: {
    backgroundColor: '#14532D',
    borderWidth: 1,
    borderColor: '#22C55E',
  },
  statusBadgeWaiting: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statusBadgeTextReady: {
    color: '#22C55E',
  },
  statusBadgeTextWaiting: {
    color: '#888888',
  },

  // Empty state
  emptyMembers: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyMembersText: {
    color: '#555555',
    fontSize: 13,
  },

  // Bottom sticky bar
  stickyBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
    backgroundColor: '#0A0A0A',
  },
  startBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  startBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 17,
  },
  readyBtn: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#DC143C',
  },
  readyBtnActive: {
    backgroundColor: '#DC143C',
    borderColor: '#DC143C',
  },
  readyBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 17,
  },
});

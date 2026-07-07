/**
 * ConvoyLobbyScreen — pre-drive waiting room where members gather before a convoy starts.
 * The leader sees a "Start Convoy" button; members see an "I'm Ready" toggle.
 * Three staggered radar-pulse rings animate behind the member list header.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { authService } from '../services/AuthService';
import { WebSocketService } from '../services/WebSocketService';
import { useAuthStore } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';
import { useSocketStore } from '../stores/socketStore';
import { useTheme, ThemeColors } from '../theme';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const SOCKET_URL = API_URL.replace(/^http/, 'ws');

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
  const { colors } = useTheme();
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
      style={[radarStyles.ring, { borderColor: colors.accent }, { transform: [{ scale }], opacity }]}
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [members, setMembers] = useState<LobbyMember[]>([]);
  const [selfReady, setSelfReady] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (startTimeoutRef.current) clearTimeout(startTimeoutRef.current);
    };
  }, []);

  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const adminId = useGroupStore((s) => s.adminId);
  const { socket } = useSocketStore();

  const isLeader = !!user && !!adminId && user.id === adminId;

  // -- Socket bootstrap ------------------------------------------------------
  // The lobby is reached before the (tabs)/convoy screen ever mounts, so —
  // unlike every other group-scoped screen — there's no live group socket yet
  // (MapScreen is normally what opens it). Stand one up here so "I'm Ready" /
  // "Start Convoy" and the convoy:started broadcast all work while waiting.
  // When the group's own convoy tab mounts afterwards it opens its own socket
  // and replaces this one via socketStore.setSocket (which disconnects the
  // stale connection) — same handoff pattern as Idle → active MapScreen.
  useEffect(() => {
    if (!token || !groupId) return;

    const wsService = new WebSocketService({
      url: SOCKET_URL,
      auth: { token, groupId },
      onAuthError: async () => {
        const newToken = await authService.refreshToken();
        if (!newToken) throw new Error('Token refresh failed');
        return newToken;
      },
      onAuthFailed: () => {
        useAuthStore.getState().signOut();
      },
    });
    const lobbySocket = wsService.connect();
    useSocketStore.getState().setSocket(lobbySocket);

    return () => {
      wsService.disconnect();
      // Only clear the store if nothing else (e.g. the convoy tab's own
      // socket) has already taken its place.
      if (useSocketStore.getState().socket === lobbySocket) {
        useSocketStore.getState().setSocket(null);
      }
    };
  }, [token, groupId]);

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
      // Server echoes convoy:started back to the leader's own socket too (io.to(room),
      // not socket.to) — this is now the single path that fires onConvoyStart, for both
      // the leader and members, so it never double-fires.
      if (startTimeoutRef.current) {
        clearTimeout(startTimeoutRef.current);
        startTimeoutRef.current = null;
      }
      setIsStarting(false);
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
    if (!socket || isStarting) return;
    setStartError(null);
    setIsStarting(true);
    socket.emit('convoy:start', { groupId });
    // convoy:start has no ack — if the server never broadcasts convoy:started back
    // (dropped connection, non-leader race, server-side failure), the leader would
    // otherwise sit on a button that looks pressed forever with no feedback at all.
    startTimeoutRef.current = setTimeout(() => {
      setIsStarting(false);
      setStartError("Couldn't start the convoy — check your connection and try again.");
    }, 8000);
  }, [socket, groupId, isStarting]);

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
          <Ionicons name="chevron-back" size={22} color={colors.text} style={styles.backArrow} />
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
        style={styles.scrollBody}
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
                {m.isReady ? <><Ionicons name="checkmark" size={11} color="#4ADE80" /> Ready</> : 'Waiting…'}
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
          <>
            {startError ? (
              <Text style={styles.startErrorText}>{startError}</Text>
            ) : null}
            <TouchableOpacity
              style={[styles.startBtn, isStarting && styles.startBtnDisabled]}
              onPress={handleStartConvoy}
              disabled={isStarting}
              accessibilityRole="button"
              accessibilityLabel={isStarting ? 'Starting convoy' : 'Start convoy'}
              accessibilityState={{ disabled: isStarting, busy: isStarting }}
            >
              <Text style={styles.startBtnText}>{isStarting ? 'Starting…' : 'Start Convoy'}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={[styles.readyBtn, selfReady && styles.readyBtnActive]}
            onPress={handleToggleReady}
            disabled={selfReady}
            accessibilityRole="button"
            accessibilityLabel={selfReady ? "You are ready" : "Mark yourself as ready"}
            accessibilityState={{ selected: selfReady }}
          >
            <Text style={[styles.readyBtnText, selfReady && styles.readyBtnTextActive]}>
              {selfReady ? <>I'm Ready <Ionicons name="checkmark" size={15} color="#FFFFFF" /></> : "I'm Ready"}
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

// Dimensions-only (no color) — borderColor is applied inline above via useTheme()
const radarStyles = StyleSheet.create({
  ring: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 1.5,
  },
});

// ---------------------------------------------------------------------------
// Screen styles
// ---------------------------------------------------------------------------

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
    color: colors.text,
    fontSize: 22,
    fontWeight: '600',
    width: 32,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 32,
  },

  // Group name + waiting label
  groupName: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  waitingLabel: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },

  // Scroll body
  // `flex: 1` is required here: without a bounded height, RN's ScrollView
  // sizes itself to its own content instead of the remaining space between
  // the header and the sticky bar. With a long member list that means the
  // view can't actually scroll — its native contentSize == its own frame —
  // so rows past the bottom of the screen become permanently unreachable
  // and the "Start Convoy" / "I'm Ready" sticky bar gets pushed off-screen
  // instead of staying pinned above the visible member rows.
  scrollBody: {
    flex: 1,
  },
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
    color: colors.textMuted,
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
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 64,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  // avatar's background is the fixed-value accent color (same in both themes),
  // so its initials stay fixed white for contrast rather than colors.text.
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
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  memberCallsign: {
    color: colors.textMuted,
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
    borderColor: colors.success,
  },
  statusBadgeWaiting: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  // statusBadgeReady's background is a fixed dark-green literal regardless of
  // theme, so this label needs a fixed light green too — colors.success alone
  // is a darker green in light mode and drops to ~1.8:1 contrast against that
  // fixed dark background (fails WCAG AA, which needs 4.5:1).
  statusBadgeTextReady: {
    color: '#4ADE80',
  },
  statusBadgeTextWaiting: {
    color: colors.textMuted,
  },

  // Empty state
  emptyMembers: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyMembersText: {
    color: colors.textSubtle,
    fontSize: 13,
  },

  // Bottom sticky bar
  stickyBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  startBtn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  startBtnDisabled: {
    opacity: 0.6,
  },
  // startBtn's background is the fixed-value accent color, so its label
  // stays fixed white for contrast rather than colors.text.
  startBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 17,
  },
  startErrorText: {
    color: colors.error,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
  },
  readyBtn: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.accent,
  },
  readyBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  readyBtnText: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 17,
  },
  // readyBtnActive overrides the background to the fixed-value accent color, so
  // the label needs to switch to fixed white too — colors.text alone would drop
  // to near-black-on-crimson (fails contrast) in light mode once active.
  readyBtnTextActive: {
    color: '#FFFFFF',
  },
  });
}

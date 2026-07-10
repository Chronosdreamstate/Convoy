/**
 * PTTLogPanel — PTT transmission log for the active group session.
 * Requirements: 27.1–27.5
 * Entries capped at MAX_ENTRIES; collapsed to ticker when panel is minimized.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Socket } from 'socket.io-client';
import { apiClient } from '../services/apiClient';
import { pttAnalytics, PttStat } from '../services/PTTAnalyticsService';
import { ThemeColors, useTheme, withAlpha } from '../theme';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PttLogEntry {
  id: string;
  userId: string;
  displayName: string;
  callsign: string | null;
  channelId: string | null;
  startedAt: string; // ISO-8601
  endedAt?: string;  // set when ptt:ended fires
  vehicleType?: string;
  distanceFromLeaderM?: number;
}

interface Props {
  socket: Pick<Socket, 'on' | 'off' | 'emit'>;
  initialEntries?: PttLogEntry[];
  groupId?: string;
  /** True when the vehicle is in motion (Req 33) — caps the visible log to the
   *  most recent entries so the scrollable list doesn't invite extended reading
   *  while driving. Derived via deriveMotionState in the parent screen. */
  isInMotion?: boolean;
}

/** Driver Distraction — Scrollable List Limit (Req 33): cap to ~4 rows while in motion. */
const IN_MOTION_LIST_CAP = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function formatDuration(startIso: string, endIso?: string): string {
  const endMs = endIso ? new Date(endIso).getTime() : Date.now();
  const s = Math.floor((endMs - new Date(startIso).getTime()) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

function formatFullTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getVehicleEmoji(vehicleType?: string): string {
  const map: Record<string, string> = {
    car: '🚗', sports_car: '🏎️', suv: '🚙', truck: '🛻',
    motorcycle: '🏍️', van: '🚐', track_car: '🏎️',
  };
  return vehicleType ? (map[vehicleType.toLowerCase()] ?? '') : '';
}

/** Merge REST-backfilled history into the live entry list (Req 27.2).
 *  Live entries win on id collision (they may already carry endedAt); result
 *  is chronological by startedAt and capped to MAX_ENTRIES most-recent. */
function mergeEntries(live: PttLogEntry[], backlog: PttLogEntry[]): PttLogEntry[] {
  const seen = new Set(live.map((e) => e.id));
  const merged = [...live, ...backlog.filter((e) => !seen.has(e.id))];
  merged.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  return merged.slice(-MAX_ENTRIES);
}

// ---------------------------------------------------------------------------
// PulsingDot
// ---------------------------------------------------------------------------

function PulsingDot({ colors }: { colors: ThemeColors }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 550, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent, marginRight: 5 }, { opacity }]} />;
}

// ---------------------------------------------------------------------------
// LogRow — expandable entry
// ---------------------------------------------------------------------------

function LogRow({
  entry,
  isActive,
  tick,
  isExpanded,
  onPress,
  onReplayRequest,
}: {
  entry: PttLogEntry;
  isActive: boolean;
  tick: number;
  isExpanded: boolean;
  onPress: () => void;
  onReplayRequest: (id: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const translateY = useRef(new Animated.Value(-16)).current;
  const rowOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.timing(rowOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  void tick; // triggers elapsed recalc

  const name = entry.callsign ?? entry.displayName;
  const emoji = getVehicleEmoji(entry.vehicleType);
  const elapsed = formatRelative(entry.startedAt);
  // Only show a ticking (open-ended) duration while the transmission is
  // actually live. Entries with no endedAt that AREN'T live — REST-backfilled
  // history, or a missed ptt:ended event — would otherwise display an
  // ever-growing bogus duration.
  const duration = entry.endedAt || isActive
    ? formatDuration(entry.startedAt, entry.endedAt)
    : null;

  return (
    <Animated.View style={{ transform: [{ translateY }], opacity: rowOpacity }}>
      <TouchableOpacity
        onPress={onPress}
        style={[styles.row, isExpanded && styles.rowExpanded]}
        accessibilityRole="button"
        accessibilityLabel={`${name} transmitted ${elapsed}. ${isExpanded ? 'Expanded' : 'Collapsed'}, double tap to ${isExpanded ? 'collapse' : 'expand'}.`}
        activeOpacity={0.7}
      >
        {/* Main row */}
        <View style={styles.rowMain}>
          <Ionicons
            name={isActive ? 'radio' : 'radio-outline'}
            size={15}
            color={isActive ? colors.accent : colors.textMuted}
            style={styles.radioIcon}
          />

          <View style={styles.rowBody}>
            <View style={styles.nameRow}>
              {isActive && <PulsingDot colors={colors} />}
              <Text style={styles.callsign} numberOfLines={1}>
                {emoji ? `${emoji} ` : ''}{name}
              </Text>
              {isActive && <Text style={styles.liveLabel}> LIVE</Text>}
            </View>
            <Text style={styles.channelLabel} numberOfLines={1}>
              {entry.channelId ? `#${entry.channelId}` : 'all channels'}{duration ? ` · ${duration}` : ''}
            </Text>
          </View>

          <Text style={styles.elapsed}>{elapsed}</Text>
          <Ionicons
            name={isExpanded ? 'chevron-up' : 'chevron-down'}
            size={13}
            color={colors.textSubtle}
          />
        </View>

        {/* Expanded details */}
        {isExpanded && (
          <View style={styles.expandedBody}>
            <Text style={styles.expandedRow}>🕐 {formatFullTimestamp(entry.startedAt)}</Text>
            {duration != null && <Text style={styles.expandedRow}>⏱ Duration: {duration}</Text>}
            {entry.distanceFromLeaderM != null && (
              <Text style={styles.expandedRow}>
                📍 {entry.distanceFromLeaderM >= 1000
                  ? `${(entry.distanceFromLeaderM / 1000).toFixed(1)} km from lead`
                  : `${Math.round(entry.distanceFromLeaderM)} m from lead`}
              </Text>
            )}
            <TouchableOpacity
              onPress={() => onReplayRequest(entry.id)}
              style={styles.replayBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Request replay of this transmission"
            >
              <Ionicons name="repeat" size={12} color={colors.textMuted} />
              <Text style={styles.replayBtnText}>Request replay</Text>
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// PTTLogPanel
// ---------------------------------------------------------------------------

function PTTLogPanel({ socket, initialEntries = [], groupId, isInMotion = false }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [entries, setEntries] = useState<PttLogEntry[]>(
    initialEntries.slice(-MAX_ENTRIES),
  );
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [leaderboard, setLeaderboard] = useState<PttStat[]>([]);
  const [backfillStatus, setBackfillStatus] = useState<'idle' | 'loading' | 'error' | 'done'>('idle');

  // Synchronous ref so handlePttEnded can read entries without a stale closure
  const entriesRef = useRef(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);

  // ── Cold-open backfill (Req 27.2) ──────────────────────────────────────────
  // Live socket events only cover transmissions after this panel mounted;
  // fetch the session's earlier log over REST and merge it in, so opening the
  // panel mid-session shows the full history. Live events keep flowing
  // independently — mergeEntries dedupes by id and re-sorts chronologically.
  const fetchBacklog = useCallback(async () => {
    if (!groupId) return;
    setBackfillStatus('loading');
    try {
      const res = await apiClient.get<{
        log: Array<{
          id: string;
          userId: string;
          channelId: string | null;
          startedAt: string;
          endedAt: string | null;
          displayName: string;
          callsign: string | null;
        }>;
      }>(`/api/v1/groups/${groupId}/ptt-log`);
      const backlog: PttLogEntry[] = res.data.log.map((r) => ({
        id: r.id,
        userId: r.userId,
        displayName: r.displayName,
        callsign: r.callsign,
        channelId: r.channelId,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? undefined,
      }));
      setEntries((prev) => mergeEntries(prev, backlog));
      setBackfillStatus('done');
    } catch {
      // Live updates still work without the backlog — degrade to a small
      // inline notice with a manual retry.
      setBackfillStatus('error');
    }
  }, [groupId]);

  useEffect(() => { void fetchBacklog(); }, [fetchBacklog]);

  // Tick every second for relative timestamps
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handlePttTransmit = useCallback(
    (data: { logId: string; userId: string; channelId: string; callsign?: string; vehicleType?: string }) => {
      const entry: PttLogEntry = {
        id: data.logId,
        userId: data.userId,
        displayName: data.userId,
        callsign: data.callsign ?? null,
        channelId: data.channelId,
        startedAt: new Date().toISOString(),
        vehicleType: data.vehicleType,
      };
      setEntries((prev) => [...prev, entry].slice(-MAX_ENTRIES));
      setActiveUserId(data.userId);
      setUnread((u) => (collapsed ? u + 1 : 0));
    },
    [collapsed],
  );

  const handlePttEnded = useCallback(
    (data?: { logId?: string; userId?: string; durationMs?: number }) => {
      setActiveUserId(null);
      if (data?.logId) {
        const endedAt = new Date().toISOString();
        setEntries((prev) =>
          prev.map((e) => (e.id === data.logId ? { ...e, endedAt } : e)),
        );
        // Record analytics using durationMs supplied by the server
        if (data.userId != null && data.durationMs != null && data.durationMs > 0) {
          const entry = entriesRef.current.find((e) => e.id === data.logId);
          const callsign = entry?.callsign ?? entry?.displayName ?? data.userId;
          pttAnalytics.recordTransmit(data.userId, callsign, data.durationMs);
          setLeaderboard(pttAnalytics.getLeaderboard());
        }
      }
    },
    [],
  );

  const handleGroupEnded = useCallback(() => {
    setEntries([]);
    setActiveUserId(null);
    setUnread(0);
    pttAnalytics.reset();
    setLeaderboard([]);
  }, []);

  useEffect(() => {
    socket.on('ptt:transmit', handlePttTransmit);
    socket.on('ptt:ended', handlePttEnded);
    socket.on('group:ended', handleGroupEnded);
    return () => {
      socket.off('ptt:transmit', handlePttTransmit);
      socket.off('ptt:ended', handlePttEnded);
      socket.off('group:ended', handleGroupEnded);
    };
  }, [socket, handlePttTransmit, handlePttEnded, handleGroupEnded]);

  function handleToggleCollapse() {
    setCollapsed((c) => !c);
    setUnread(0);
  }

  function handleRowPress(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function handleReplayRequest(id: string) {
    socket.emit('ptt:replay_request', { messageId: id });
  }

  const lastEntry = entries[entries.length - 1];

  return (
    <View style={styles.panel}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerLabel}>RADIO LOG</Text>
        <View style={styles.headerRight}>
          {entries.length > 0 && (
            <TouchableOpacity
              onPress={() => { setEntries([]); setUnread(0); setExpandedId(null); }}
              style={styles.clearBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Clear radio log"
            >
              <Text style={styles.clearBtnText}>Clear</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={handleToggleCollapse}
            style={styles.collapseBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={collapsed ? 'Expand radio log' : 'Collapse radio log'}
          >
            {unread > 0 && collapsed && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
              </View>
            )}
            <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} color={colors.textMuted} style={styles.collapseIcon} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Collapsed: single-line ticker */}
      {collapsed ? (
        <TouchableOpacity
          onPress={handleToggleCollapse}
          style={styles.ticker}
          accessibilityRole="button"
          accessibilityLabel={lastEntry ? `Expand radio log. Last transmission: ${lastEntry.callsign ?? lastEntry.displayName}, ${formatRelative(lastEntry.startedAt)}.` : 'Expand radio log. No transmissions yet.'}
        >
          {lastEntry ? (
            <View style={styles.tickerRow}>
              <Ionicons name="radio-outline" size={13} color={colors.textMuted} style={styles.tickerIcon} />
              <Text style={styles.tickerText} numberOfLines={1}>
                {lastEntry.callsign ?? lastEntry.displayName} · {formatRelative(lastEntry.startedAt)}
              </Text>
            </View>
          ) : (
            <Text style={styles.emptyText}>No transmissions yet</Text>
          )}
        </TouchableOpacity>
      ) : (
        /* Expanded: scrollable list */
        <>
          {backfillStatus === 'error' && (
            <View style={styles.backfillNotice}>
              <Text style={styles.backfillNoticeText}>Couldn't load earlier transmissions.</Text>
              <TouchableOpacity
                onPress={() => void fetchBacklog()}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Retry loading earlier transmissions"
              >
                <Text style={styles.backfillRetryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          {entries.length === 0 ? (
            <View style={styles.emptyRow}>
              {backfillStatus === 'loading' ? (
                <ActivityIndicator
                  size="small"
                  color={colors.textMuted}
                  accessibilityLabel="Loading transmission history"
                />
              ) : (
                <Text style={styles.emptyText}>No transmissions yet</Text>
              )}
            </View>
          ) : (
            <>
              <TouchableOpacity
                onPress={() => socket.emit('ptt:replay_request', { groupId, userId: lastEntry?.userId })}
                style={styles.replayLastBtn}
                accessibilityRole="button"
                accessibilityLabel="Replay last transmission"
              >
                <Ionicons name="repeat" size={13} color={colors.accent} />
                <Text style={styles.replayLastBtnText}>Replay Last</Text>
              </TouchableOpacity>
              <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                {(isInMotion ? entries.slice(-IN_MOTION_LIST_CAP) : entries).map((entry) => (
                  <LogRow
                    key={entry.id}
                    entry={entry}
                    isActive={entry.userId === activeUserId}
                    tick={tick}
                    isExpanded={expandedId === entry.id}
                    onPress={() => handleRowPress(entry.id)}
                    onReplayRequest={handleReplayRequest}
                  />
                ))}
              </ScrollView>
            </>
          )}
        </>
      )}

      {/* Stats footer — top 3 speakers, shown only when expanded and data exists */}
      {!collapsed && leaderboard.length > 0 && (
        <View style={styles.statsFooter}>
          <Text style={styles.statsTitle}>TOP SPEAKERS</Text>
          {leaderboard.slice(0, 3).map((stat, index) => (
            <View key={stat.userId} style={styles.statsRow}>
              <Text style={styles.statsMedal}>
                {(['🥇', '🥈', '🥉'] as const)[index]}
              </Text>
              <Text style={styles.statsCallsign} numberOfLines={1}>
                {stat.callsign}
              </Text>
              <View style={styles.statsValues}>
                <Text style={styles.statsCount}>{stat.transmitCount}×</Text>
                <Text style={styles.statsDuration}>
                  {pttAnalytics.formatDuration(stat.totalDurationMs)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const MemoPTTLogPanel = React.memo(PTTLogPanel);
MemoPTTLogPanel.displayName = 'PTTLogPanel';
export default MemoPTTLogPanel;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    panel: {
      backgroundColor: withAlpha(colors.card, 0.94),
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      maxHeight: 400,
    },

    // Header
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 7,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerLabel: {
      color: colors.textSubtle,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 2.5,
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    clearBtn: {
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    clearBtnText: {
      color: colors.textSubtle,
      fontSize: 11,
    },
    collapseBtn: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    collapseIcon: {
      paddingHorizontal: 4,
    },

    // Unread badge
    badge: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      minWidth: 16,
      height: 16,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 3,
      marginRight: 4,
    },
    // Fixed-value accent badge (same in both themes) — label stays fixed white.
    badgeText: {
      color: '#FFFFFF',
      fontSize: 9,
      fontWeight: '700',
    },

    // Ticker (collapsed)
    ticker: {
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    tickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    tickerIcon: {
      marginRight: 6,
    },
    tickerText: {
      color: colors.textMuted,
      fontSize: 12,
    },

    // Backfill failure notice (history fetch failed; live updates unaffected)
    backfillNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    backfillNoticeText: {
      color: colors.textSubtle,
      fontSize: 11,
    },
    backfillRetryText: {
      color: colors.accent,
      fontSize: 11,
      fontWeight: '700',
    },

    // List (expanded)
    list: {
      maxHeight: 220,
    },
    emptyRow: {
      paddingVertical: 14,
      alignItems: 'center',
    },
    emptyText: {
      color: colors.textSubtle,
      fontSize: 12,
    },

    // Row
    row: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowExpanded: {
      backgroundColor: withAlpha(colors.accent, 0.06),
    },
    rowMain: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    radioIcon: {
      marginRight: 9,
    },
    rowBody: {
      flex: 1,
      marginRight: 8,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    callsign: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.text,
      flexShrink: 1,
    },
    liveLabel: {
      fontSize: 9,
      fontWeight: '800',
      color: colors.accent,
      letterSpacing: 1.5,
      marginLeft: 2,
    },
    channelLabel: {
      fontSize: 11,
      color: colors.textMuted,
      marginTop: 1,
    },
    elapsed: {
      fontSize: 10,
      color: colors.textSubtle,
      minWidth: 44,
      textAlign: 'right',
      marginRight: 4,
    },

    // Expanded details
    expandedBody: {
      paddingHorizontal: 36,
      paddingBottom: 10,
      gap: 4,
    },
    expandedRow: {
      fontSize: 12,
      color: colors.textMuted,
    },
    replayBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginTop: 6,
      alignSelf: 'flex-start',
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
    },
    replayBtnText: {
      fontSize: 11,
      color: colors.textMuted,
    },

    // "Replay Last" panel-level button
    replayLastBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      alignSelf: 'flex-end',
      marginBottom: 8,
      marginTop: 8,
      marginRight: 12,
      backgroundColor: withAlpha(colors.accent, 0.15),
      borderColor: colors.accent,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    replayLastBtnText: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '600',
    },

    // Stats footer
    statsFooter: {
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 10,
      gap: 6,
    },
    statsTitle: {
      color: colors.textSubtle,
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 2,
      marginBottom: 2,
    },
    statsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    statsMedal: {
      fontSize: 14,
      width: 20,
    },
    statsCallsign: {
      flex: 1,
      fontSize: 12,
      fontWeight: '600',
      color: colors.text,
    },
    statsValues: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    statsCount: {
      fontSize: 11,
      color: colors.textMuted,
      minWidth: 24,
      textAlign: 'right',
    },
    statsDuration: {
      fontSize: 11,
      color: colors.textMuted,
      minWidth: 44,
      textAlign: 'right',
    },
  });
}

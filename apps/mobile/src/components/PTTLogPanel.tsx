/**
 * PTTLogPanel — PTT transmission log for the active group session.
 * Requirements: 27.1–27.5
 * Entries capped at MAX_ENTRIES; collapsed to ticker when panel is minimized.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Socket } from 'socket.io-client';
import { pttAnalytics, PttStat } from '../services/PTTAnalyticsService';

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
}

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

// ---------------------------------------------------------------------------
// PulsingDot
// ---------------------------------------------------------------------------

function PulsingDot() {
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
  return <Animated.View style={[styles.dot, { opacity }]} />;
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
  const duration = formatDuration(entry.startedAt, entry.endedAt);

  return (
    <Animated.View style={{ transform: [{ translateY }], opacity: rowOpacity }}>
      <TouchableOpacity
        onPress={onPress}
        style={[styles.row, isExpanded && styles.rowExpanded]}
        accessible
        accessibilityLabel={`${name} transmitted ${elapsed}`}
        activeOpacity={0.7}
      >
        {/* Main row */}
        <View style={styles.rowMain}>
          <Text style={styles.radioEmoji}>{isActive ? '🔴' : '📻'}</Text>

          <View style={styles.rowBody}>
            <View style={styles.nameRow}>
              {isActive && <PulsingDot />}
              <Text style={styles.callsign} numberOfLines={1}>
                {emoji ? `${emoji} ` : ''}{name}
              </Text>
              {isActive && <Text style={styles.liveLabel}> LIVE</Text>}
            </View>
            <Text style={styles.channelLabel} numberOfLines={1}>
              {entry.channelId ? `#${entry.channelId}` : 'all channels'} · {duration}
            </Text>
          </View>

          <Text style={styles.elapsed}>{elapsed}</Text>
          <Text style={styles.chevron}>{isExpanded ? '▲' : '▼'}</Text>
        </View>

        {/* Expanded details */}
        {isExpanded && (
          <View style={styles.expandedBody}>
            <Text style={styles.expandedRow}>🕐 {formatFullTimestamp(entry.startedAt)}</Text>
            <Text style={styles.expandedRow}>⏱ Duration: {duration}</Text>
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
              accessibilityLabel="Request replay"
            >
              <Text style={styles.replayBtnText}>🔁 Request replay</Text>
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

function PTTLogPanel({ socket, initialEntries = [], groupId }: Props) {
  const [entries, setEntries] = useState<PttLogEntry[]>(
    initialEntries.slice(-MAX_ENTRIES),
  );
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [leaderboard, setLeaderboard] = useState<PttStat[]>([]);

  // Synchronous ref so handlePttEnded can read entries without a stale closure
  const entriesRef = useRef(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);

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
              accessibilityLabel="Clear log"
            >
              <Text style={styles.clearBtnText}>Clear</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={handleToggleCollapse}
            style={styles.collapseBtn}
            accessibilityLabel={collapsed ? 'Expand radio log' : 'Collapse radio log'}
          >
            {unread > 0 && collapsed && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
              </View>
            )}
            <Text style={styles.collapseBtnText}>{collapsed ? '▼' : '▲'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Collapsed: single-line ticker */}
      {collapsed ? (
        <TouchableOpacity onPress={handleToggleCollapse} style={styles.ticker}>
          {lastEntry ? (
            <Text style={styles.tickerText} numberOfLines={1}>
              📻 {lastEntry.callsign ?? lastEntry.displayName} · {formatRelative(lastEntry.startedAt)}
            </Text>
          ) : (
            <Text style={styles.emptyText}>No transmissions yet</Text>
          )}
        </TouchableOpacity>
      ) : (
        /* Expanded: scrollable list */
        entries.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.emptyText}>No transmissions yet</Text>
          </View>
        ) : (
          <>
            {entries.length > 0 && (
              <TouchableOpacity
                onPress={() => socket.emit('ptt:replay_request', { groupId, userId: lastEntry?.userId })}
                style={styles.replayLastBtn}
                accessibilityLabel="Replay last transmission"
              >
                <Text style={styles.replayLastBtnText}>🔁 Replay Last</Text>
              </TouchableOpacity>
            )}
            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
              {entries.map((entry) => (
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
        )
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

const styles = StyleSheet.create({
  panel: {
    backgroundColor: 'rgba(28, 28, 28, 0.94)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
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
    borderBottomColor: '#2A2A2A',
  },
  headerLabel: {
    color: '#555555',
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
    color: '#555555',
    fontSize: 11,
  },
  collapseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  collapseBtnText: {
    color: '#888888',
    fontSize: 11,
    paddingHorizontal: 4,
  },

  // Unread badge
  badge: {
    backgroundColor: '#DC143C',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    marginRight: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },

  // Ticker (collapsed)
  ticker: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tickerText: {
    color: '#888888',
    fontSize: 12,
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
    color: '#555555',
    fontSize: 12,
  },

  // Row
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2A2A2A',
  },
  rowExpanded: {
    backgroundColor: 'rgba(220,20,60,0.06)',
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  radioEmoji: {
    fontSize: 13,
    marginRight: 9,
    opacity: 0.85,
  },
  rowBody: {
    flex: 1,
    marginRight: 8,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#DC143C',
    marginRight: 5,
  },
  callsign: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    flexShrink: 1,
  },
  liveLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#DC143C',
    letterSpacing: 1.5,
    marginLeft: 2,
  },
  channelLabel: {
    fontSize: 11,
    color: '#888888',
    marginTop: 1,
  },
  elapsed: {
    fontSize: 10,
    color: '#555555',
    minWidth: 44,
    textAlign: 'right',
    marginRight: 4,
  },
  chevron: {
    fontSize: 9,
    color: '#555555',
  },

  // Expanded details
  expandedBody: {
    paddingHorizontal: 36,
    paddingBottom: 10,
    gap: 4,
  },
  expandedRow: {
    fontSize: 12,
    color: '#888888',
  },
  replayBtn: {
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 6,
  },
  replayBtnText: {
    fontSize: 11,
    color: '#AAAAAA',
  },

  // "Replay Last" panel-level button
  replayLastBtn: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    marginBottom: 8,
    marginTop: 8,
    marginRight: 12,
    backgroundColor: 'rgba(220,20,60,0.15)',
    borderColor: '#DC143C',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  replayLastBtnText: {
    color: '#DC143C',
    fontSize: 12,
    fontWeight: '600',
  },

  // Stats footer
  statsFooter: {
    backgroundColor: '#1C1C1C',
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 6,
  },
  statsTitle: {
    color: '#555555',
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
    color: '#FFFFFF',
  },
  statsValues: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statsCount: {
    fontSize: 11,
    color: '#888888',
    minWidth: 24,
    textAlign: 'right',
  },
  statsDuration: {
    fontSize: 11,
    color: '#888888',
    minWidth: 44,
    textAlign: 'right',
  },
});

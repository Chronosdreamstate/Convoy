/**
 * PTTLogPanel — Shows the PTT transmission log for the active group session.
 * Requirements: 27.1–27.5
 * Entries displayed oldest-first; cleared automatically on group:ended.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Socket } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 5;

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
}

interface Props {
  socket: Pick<Socket, 'on' | 'off'>;
  initialEntries?: PttLogEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// PulsingDot — animated red indicator for active transmission
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
// AnimatedLogRow — slides in from above on mount, updates elapsed every tick
// ---------------------------------------------------------------------------

function AnimatedLogRow({
  entry,
  isActive,
  tick, // triggers elapsed re-render
}: {
  entry: PttLogEntry;
  isActive: boolean;
  tick: number;
}) {
  const translateY = useRef(new Animated.Value(-20)).current;
  const rowOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(rowOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = entry.callsign ?? entry.displayName;
  const elapsed = formatElapsed(entry.startedAt);
  // Suppress lint for tick — it intentionally triggers elapsed recalc
  void tick;

  return (
    <Animated.View
      style={[styles.row, { transform: [{ translateY }], opacity: rowOpacity }]}
      accessible
      accessibilityLabel={`${name} transmitted ${elapsed}`}
    >
      <Text style={styles.radioEmoji}>📻</Text>

      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          {isActive && <PulsingDot />}
          <Text style={styles.callsign} numberOfLines={1}>{name}</Text>
          {isActive && <Text style={styles.txBadge}> TX</Text>}
        </View>
        <Text style={styles.channelLabel} numberOfLines={1}>
          {entry.channelId ? `#${entry.channelId}` : 'all channels'}
        </Text>
      </View>

      <Text style={styles.elapsed}>{elapsed}</Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// PTTLogPanel
// ---------------------------------------------------------------------------

function PTTLogPanel({ socket, initialEntries = [] }: Props) {
  const [entries, setEntries] = useState<PttLogEntry[]>(initialEntries);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Refresh elapsed timestamps every second
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handlePttTransmit = useCallback(
    (data: { logId: string; userId: string; channelId: string }) => {
      const entry: PttLogEntry = {
        id: data.logId,
        userId: data.userId,
        displayName: data.userId, // enriched by parent via REST if needed
        callsign: null,
        channelId: data.channelId,
        startedAt: new Date().toISOString(),
      };
      setEntries((prev) => [...prev, entry]);
      setActiveUserId(data.userId);
    },
    [],
  );

  const handlePttEnded = useCallback(() => {
    setActiveUserId(null);
  }, []);

  const handleGroupEnded = useCallback(() => {
    setEntries([]); // Clear log on session end (Req 27.4)
    setActiveUserId(null);
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

  const visible = entries.slice(-MAX_VISIBLE);

  return (
    <View style={styles.panel}>
      <Text style={styles.header}>RADIO LOG</Text>

      {visible.length === 0 ? (
        <View style={styles.emptyRow}>
          <Text style={styles.emptyText}>No transmissions yet</Text>
        </View>
      ) : (
        visible.map((entry) => (
          <AnimatedLogRow
            key={entry.id}
            entry={entry}
            isActive={entry.userId === activeUserId}
            tick={tick}
          />
        ))
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
  },

  header: {
    color: '#555555',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2.5,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },

  emptyRow: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  emptyText: {
    color: '#555555',
    fontSize: 12,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2A2A2A',
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
    color: '#DC143C',
    flexShrink: 1,
  },
  txBadge: {
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
    minWidth: 38,
    textAlign: 'right',
  },
});

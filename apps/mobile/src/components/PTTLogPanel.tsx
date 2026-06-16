/**
 * PTTLogPanel — Shows the PTT transmission log for the active group session.
 * Requirements: 27.1–27.5
 * Entries displayed oldest-first; cleared automatically on group:ended.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Socket } from 'socket.io-client';

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
// Component
// ---------------------------------------------------------------------------

export default function PTTLogPanel({ socket, initialEntries = [] }: Props) {
  const [entries, setEntries] = useState<PttLogEntry[]>(initialEntries);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    flatListRef.current?.scrollToEnd({ animated: true });
  }, [entries]);

  const handlePttTransmit = useCallback(
    (data: { logId: string; userId: string; channelId: string }) => {
      // We receive displayName etc via the separate ptt:transmit payload
      // The server includes user info in a companion REST fetch; here we record
      // what we know from the socket event and the parent can enrich it.
      const entry: PttLogEntry = {
        id: data.logId,
        userId: data.userId,
        displayName: data.userId, // enriched by parent via REST if needed
        callsign: null,
        channelId: data.channelId,
        startedAt: new Date().toISOString(),
      };
      // Append and keep ascending order (Req 27.5)
      setEntries((prev) => [...prev, entry]);
    },
    [],
  );

  const handleGroupEnded = useCallback(() => {
    setEntries([]); // Clear log on session end (Req 27.4)
  }, []);

  useEffect(() => {
    socket.on('ptt:transmit', handlePttTransmit);
    socket.on('group:ended', handleGroupEnded);
    return () => {
      socket.off('ptt:transmit', handlePttTransmit);
      socket.off('group:ended', handleGroupEnded);
    };
  }, [socket, handlePttTransmit, handleGroupEnded]);

  if (entries.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No transmissions yet</Text>
      </View>
    );
  }

  return (
    <FlatList
      ref={flatListRef}
      data={entries}
      keyExtractor={(e) => e.id}
      style={styles.list}
      renderItem={({ item }) => <LogRow entry={item} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Log row
// ---------------------------------------------------------------------------

function LogRow({ entry }: { entry: PttLogEntry }) {
  const name = entry.callsign ?? entry.displayName;
  const time = new Date(entry.startedAt).toISOString().slice(11, 19); // HH:MM:SS

  return (
    <View style={styles.row}>
      <View style={styles.mic}>
        <Text style={styles.micIcon}>🎙</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        <Text style={styles.time}>{time} UTC</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#111827' },

  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#111827', padding: 24,
  },
  emptyText: { color: '#6b7280', fontSize: 13 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
  },
  mic: {
    width: 28, height: 28,
    borderRadius: 14,
    backgroundColor: '#374151',
    alignItems: 'center', justifyContent: 'center',
    marginRight: 10,
  },
  micIcon: { fontSize: 14 },
  rowBody: { flex: 1 },
  name: { fontSize: 13, fontWeight: '600', color: '#f9fafb' },
  time: { fontSize: 11, color: '#6b7280', marginTop: 1 },
});

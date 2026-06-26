import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';

interface Waypoint {
  id: string;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

let _nextId = 1;
function makeId() { return String(_nextId++); }

export default function WaypointManagementScreen() {
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const router = useRouter();

  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftAddress, setDraftAddress] = useState('');
  const [saving, setSaving] = useState(false);

  const moveUp = (index: number) => {
    if (index === 0) return;
    setWaypoints((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveDown = (index: number) => {
    setWaypoints((prev) => {
      if (index === prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  const remove = (id: string) => {
    setWaypoints((prev) => prev.filter((w) => w.id !== id));
  };

  const addWaypoint = () => {
    const name = draftName.trim();
    if (!name) return;
    setWaypoints((prev) => [
      ...prev,
      { id: makeId(), name, address: draftAddress.trim() || '' },
    ]);
    setDraftName('');
    setDraftAddress('');
    setModalVisible(false);
  };

  const loadWaypoints = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await apiClient.get<{ waypoints: Waypoint[] }>(`/api/v1/groups/${groupId}/waypoints`);
      setWaypoints(res.data.waypoints ?? []);
    } catch {
      // Non-fatal — start with empty list if fetch fails
    }
  }, [groupId]);

  useEffect(() => { void loadWaypoints(); }, [loadWaypoints]);

  const broadcast = async () => {
    if (!groupId) { router.back(); return; }
    setSaving(true);
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/waypoints`, {
        waypoints: waypoints.map((w, i) => ({
          name: w.name,
          address: w.address,
          lat: w.lat,
          lng: w.lng,
          order: i,
        })),
      });
    } catch {
      // Non-fatal — waypoints will sync next time or on reconnect
    } finally {
      setSaving(false);
      router.back();
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Waypoints</Text>
        <View style={styles.backBtn} />
      </View>

      {waypoints.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>🗺️</Text>
          <Text style={styles.emptyTitle}>No waypoints yet</Text>
          <Text style={styles.emptySubtitle}>Add your first stop to plan the route</Text>
          <TouchableOpacity
            style={styles.addCta}
            onPress={() => setModalVisible(true)}
            accessibilityRole="button"
          >
            <Text style={styles.addCtaText}>+ Add Waypoint</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <FlatList
            data={waypoints}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            renderItem={({ item, index }) => (
              <View style={styles.row}>
                {/* Order indicator */}
                <View style={styles.indexBadge}>
                  <Text style={styles.indexText}>{index + 1}</Text>
                </View>

                {/* Info */}
                <View style={styles.rowInfo}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    📍 {item.name}
                  </Text>
                  {item.address ? (
                    <Text style={styles.rowAddress} numberOfLines={1}>
                      {item.address}
                    </Text>
                  ) : null}
                </View>

                {/* Controls */}
                <View style={styles.controls}>
                  <TouchableOpacity
                    onPress={() => moveUp(index)}
                    disabled={index === 0}
                    style={[styles.arrowBtn, index === 0 && styles.arrowDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel="Move up"
                  >
                    <Text style={styles.arrowText}>↑</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => moveDown(index)}
                    disabled={index === waypoints.length - 1}
                    style={[styles.arrowBtn, index === waypoints.length - 1 && styles.arrowDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel="Move down"
                  >
                    <Text style={styles.arrowText}>↓</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => remove(item.id)}
                    style={styles.removeBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.name}`}
                  >
                    <Text style={styles.removeText}>✕</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
          />

          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => setModalVisible(true)}
              accessibilityRole="button"
            >
              <Text style={styles.addBtnText}>+ Add Waypoint</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.broadcastBtn, saving && styles.savingBtn]}
              onPress={() => { void broadcast(); }}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Broadcast waypoints to group"
            >
              {saving
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.broadcastText}>📡 Broadcast to Group</Text>}
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Add Waypoint Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Waypoint</Text>
              <TouchableOpacity
                onPress={() => setModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.input}
              placeholder="Location name *"
              placeholderTextColor="#555"
              value={draftName}
              onChangeText={setDraftName}
              autoFocus
              returnKeyType="next"
            />
            <TextInput
              style={[styles.input, { marginTop: 10 }]}
              placeholder="Address (optional)"
              placeholderTextColor="#555"
              value={draftAddress}
              onChangeText={setDraftAddress}
              returnKeyType="done"
              onSubmitEditing={addWaypoint}
            />

            <TouchableOpacity
              style={[styles.addCta, !draftName.trim() && styles.addCtaDisabled]}
              onPress={addWaypoint}
              disabled={!draftName.trim()}
              accessibilityRole="button"
            >
              <Text style={styles.addCtaText}>Add Stop</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  backBtn: { width: 60 },
  backText: { color: '#DC143C', fontSize: 17, fontWeight: '500' },
  title: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },

  list: { padding: 16, paddingBottom: 0 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 12,
  },
  indexBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  indexText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  rowInfo: { flex: 1, marginRight: 8 },
  rowName: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  rowAddress: { color: '#888888', fontSize: 13, marginTop: 2 },

  controls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  arrowBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowDisabled: { opacity: 0.3 },
  arrowText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  removeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#3A0A14',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  removeText: { color: '#DC143C', fontSize: 15, fontWeight: '700' },

  separator: { height: 8 },

  footer: { padding: 16, gap: 10 },
  addBtn: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  addBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  broadcastBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  savingBtn: { opacity: 0.6 },
  broadcastText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyEmoji: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySubtitle: { color: '#888888', fontSize: 14, textAlign: 'center', marginBottom: 32 },
  addCta: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    alignItems: 'center',
    minWidth: 200,
  },
  addCtaDisabled: { opacity: 0.4 },
  addCtaText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000088',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  modalClose: { color: '#888888', fontSize: 20, padding: 4 },
  input: {
    backgroundColor: '#0A0A0A',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    color: '#FFFFFF',
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 48,
  },
});

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GroupSettings {
  id: string;
  name: string;
  gapThresholdM: number;
  pttMaxSeconds: number;
  accessType: 'open' | 'invite_only';
}

interface GroupMember {
  userId: string;
  displayName: string;
  pttCallsign: string | null;
  isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Pill selector
// ---------------------------------------------------------------------------

function PillSelector<T extends string | number>({
  options,
  value,
  onSelect,
  disabled,
}: {
  options: { label: string; value: T }[];
  value: T;
  onSelect: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.pillRow}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={String(opt.value)}
            style={[styles.pill, active && styles.pillActive, disabled && styles.pillDisabled]}
            onPress={() => { if (!disabled) onSelect(opt.value); }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.pillText, active && styles.pillTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAP_OPTIONS = [
  { label: '500 m', value: 500 },
  { label: '1 km', value: 1000 },
  { label: '2 km', value: 2000 },
  { label: '5 km', value: 5000 },
];

const PTT_OPTIONS = [
  { label: '15 s', value: 15 },
  { label: '30 s', value: 30 },
  { label: '60 s', value: 60 },
];

const ACCESS_OPTIONS = [
  { label: 'Open', value: 'open' as const },
  { label: 'Invite Only', value: 'invite_only' as const },
];

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function GroupSettingsScreen() {
  const { groupId, isAdmin: isAdminParam } = useLocalSearchParams<{ groupId: string; isAdmin: string }>();
  const isAdmin = isAdminParam === 'true';
  const router = useRouter();

  const [settings, setSettings] = useState<GroupSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable draft state
  const [name, setName] = useState('');
  const [gapThresholdM, setGapThresholdM] = useState(1000);
  const [pttMaxSeconds, setPttMaxSeconds] = useState(30);
  const [accessType, setAccessType] = useState<'open' | 'invite_only'>('open');

  // Transfer admin state
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [transferring, setTransferring] = useState(false);

  // Announcement state
  const [announcement, setAnnouncement] = useState('');
  const [sendingAnnouncement, setSendingAnnouncement] = useState(false);

  const loadSettings = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, membersRes] = await Promise.all([
        apiClient.get<GroupSettings>(`/api/v1/groups/${groupId}`),
        isAdmin
          ? apiClient.get<{ members: GroupMember[] }>(`/api/v1/groups/${groupId}/members`)
          : Promise.resolve(null),
      ]);
      const g = settingsRes.data;
      setSettings(g);
      setName(g.name);
      setGapThresholdM(g.gapThresholdM);
      setPttMaxSeconds(g.pttMaxSeconds);
      setAccessType(g.accessType);
      if (membersRes) {
        setMembers(membersRes.data.members.filter((m) => !m.isAdmin));
      }
    } catch {
      setError('Could not load group settings. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [groupId, isAdmin]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const handleSave = async () => {
    if (!groupId || !isAdmin) return;
    setSaving(true);
    try {
      await apiClient.patch(`/api/v1/groups/${groupId}/settings`, {
        name: name.trim() || undefined,
        gapThresholdM,
        pttMaxSeconds,
        accessType,
      });
      Alert.alert('Saved', 'Group settings updated.');
    } catch {
      Alert.alert('Error', 'Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleEndGroup = () => {
    Alert.alert(
      'End Group',
      'This will end the convoy and remove all members. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Group',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiClient.delete(`/api/v1/groups/${groupId}`);
              router.replace('/(tabs)/convoy');
            } catch {
              Alert.alert('Error', 'Failed to end group.');
            }
          },
        },
      ],
    );
  };

  const handleLeaveGroup = () => {
    Alert.alert(
      'Leave Group',
      'Are you sure you want to leave this group?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiClient.post(`/api/v1/groups/${groupId}/leave`);
              router.replace('/(tabs)/convoy');
            } catch {
              Alert.alert('Error', 'Failed to leave group.');
            }
          },
        },
      ],
    );
  };

  // ---- Loading ----
  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#DC143C" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  // ---- Error ----
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => { void loadSettings(); }}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const readOnly = !isAdmin;

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button">
          <Text style={styles.backBtnText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Group Settings</Text>
        {!isAdmin && (
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>Admin only</Text>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Group Name */}
        <Text style={styles.sectionHeader}>GROUP NAME</Text>
        <View style={styles.card}>
          <TextInput
            style={[styles.nameInput, readOnly && styles.inputDisabled]}
            value={name}
            onChangeText={setName}
            placeholder={settings?.name ?? 'Group name'}
            placeholderTextColor="#555"
            editable={!readOnly}
            maxLength={60}
            returnKeyType="done"
          />
        </View>

        {/* Gap Threshold */}
        <Text style={styles.sectionHeader}>GAP THRESHOLD</Text>
        <View style={styles.card}>
          <Text style={styles.settingLabel}>Alert when a member falls more than this far behind</Text>
          <PillSelector
            options={GAP_OPTIONS}
            value={gapThresholdM}
            onSelect={setGapThresholdM}
            disabled={readOnly}
          />
        </View>

        {/* PTT Max Duration */}
        <Text style={styles.sectionHeader}>PTT MAX DURATION</Text>
        <View style={styles.card}>
          <Text style={styles.settingLabel}>Maximum push-to-talk transmission length</Text>
          <PillSelector
            options={PTT_OPTIONS}
            value={pttMaxSeconds}
            onSelect={setPttMaxSeconds}
            disabled={readOnly}
          />
        </View>

        {/* Access Type */}
        <Text style={styles.sectionHeader}>ACCESS TYPE</Text>
        <View style={styles.card}>
          <Text style={styles.settingLabel}>Who can discover and join this group</Text>
          <PillSelector
            options={ACCESS_OPTIONS}
            value={accessType}
            onSelect={setAccessType}
            disabled={readOnly}
          />
        </View>

        {/* Save button */}
        {isAdmin && (
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            onPress={() => { void handleSave(); }}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Save group settings"
          >
            {saving
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.saveBtnText}>Save Changes</Text>}
          </TouchableOpacity>
        )}

        {/* Schedule event (admin only) */}
        {isAdmin && (
          <>
            <Text style={[styles.sectionHeader, { marginTop: 32 }]}>EVENTS</Text>
            <View style={styles.card}>
              <TouchableOpacity
                style={styles.scheduleBtn}
                onPress={() => router.push({ pathname: '/create-event' as never, params: { groupId } })}
                accessibilityRole="button"
                accessibilityLabel="Schedule convoy event"
              >
                <Text style={styles.scheduleBtnText}>📅 Schedule a Convoy</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Transfer Admin */}
        {isAdmin && members.length > 0 && (
          <>
            <Text style={[styles.sectionHeader, { marginTop: 32 }]}>TRANSFER ADMIN</Text>
            <View style={styles.card}>
              <Text style={styles.settingLabel}>Hand over group admin to another member</Text>
              {members.map((m) => (
                <TouchableOpacity
                  key={m.userId}
                  style={styles.memberRow}
                  disabled={transferring}
                  onPress={() => {
                    Alert.alert(
                      'Transfer Admin',
                      `Make ${m.displayName} the new admin? You will lose admin privileges.`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Transfer',
                          style: 'destructive',
                          onPress: async () => {
                            setTransferring(true);
                            try {
                              await apiClient.patch(`/api/v1/groups/${groupId}/transfer-admin`, {
                                newAdminId: m.userId,
                              });
                              Alert.alert('Done', `${m.displayName} is now the group admin.`);
                              router.replace('/(tabs)/convoy');
                            } catch {
                              Alert.alert('Error', 'Failed to transfer admin. Try again.');
                            } finally {
                              setTransferring(false);
                            }
                          },
                        },
                      ],
                    );
                  }}
                  accessibilityRole="button"
                >
                  <View style={styles.memberInfo}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>
                        {m.displayName.trim()[0]?.toUpperCase() ?? '?'}
                      </Text>
                    </View>
                    <View>
                      <Text style={styles.memberName}>{m.displayName}</Text>
                      {m.pttCallsign ? (
                        <Text style={styles.memberCallsign}>📻 {m.pttCallsign}</Text>
                      ) : null}
                    </View>
                  </View>
                  <Text style={styles.transferArrow}>›</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* Announcement Broadcast */}
        {isAdmin && (
          <>
            <Text style={[styles.sectionHeader, { marginTop: 32 }]}>ANNOUNCEMENT</Text>
            <View style={styles.card}>
              <Text style={styles.settingLabel}>Send a message to all group members</Text>
              <TextInput
                style={styles.announcementInput}
                value={announcement}
                onChangeText={(t) => setAnnouncement(t.slice(0, 200))}
                placeholder="Type your announcement..."
                placeholderTextColor="#555"
                multiline
                maxLength={200}
                returnKeyType="default"
              />
              <Text style={styles.charCount}>{announcement.length}/200</Text>
              <TouchableOpacity
                style={[styles.announceBtn, (sendingAnnouncement || announcement.trim().length === 0) && styles.announceBtnDisabled]}
                disabled={sendingAnnouncement || announcement.trim().length === 0}
                onPress={async () => {
                  if (!announcement.trim()) return;
                  setSendingAnnouncement(true);
                  try {
                    await apiClient.post(`/api/v1/groups/${groupId}/announcement`, {
                      message: announcement.trim(),
                    });
                    setAnnouncement('');
                    Alert.alert('Sent', 'Announcement delivered to all members.');
                  } catch {
                    Alert.alert('Error', 'Failed to send announcement. Try again.');
                  } finally {
                    setSendingAnnouncement(false);
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel="Send announcement"
              >
                <Text style={styles.announceBtnText}>
                  {sendingAnnouncement ? 'Sending...' : '📢 Send Announcement'}
                </Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Danger zone */}
        <Text style={[styles.sectionHeader, { marginTop: 32 }]}>DANGER ZONE</Text>
        <View style={styles.card}>
          {isAdmin && (
            <TouchableOpacity
              style={styles.dangerBtn}
              onPress={handleEndGroup}
              accessibilityRole="button"
              accessibilityLabel="End group"
            >
              <Text style={styles.dangerBtnText}>End Group</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.mutedBtn, isAdmin && { marginTop: 10 }]}
            onPress={handleLeaveGroup}
            accessibilityRole="button"
            accessibilityLabel="Leave group"
          >
            <Text style={styles.mutedBtnText}>Leave Group</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  backBtn: { paddingVertical: 8, paddingRight: 12, minHeight: 44, justifyContent: 'center' },
  backBtnText: { color: '#DC143C', fontSize: 17, fontWeight: '500' },
  headerTitle: { flex: 1, color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  adminBadge: {
    backgroundColor: '#1C1C1C',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  adminBadgeText: { color: '#888888', fontSize: 11, fontWeight: '600' },

  scrollContent: { paddingHorizontal: 16, paddingTop: 16 },

  sectionHeader: {
    color: '#888888',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 8,
    marginTop: 16,
  },

  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },

  settingLabel: { color: '#888888', fontSize: 13, marginBottom: 12 },

  nameInput: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  inputDisabled: { opacity: 0.5 },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 100,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  pillActive: { backgroundColor: '#DC143C', borderColor: '#DC143C' },
  pillDisabled: { opacity: 0.4 },
  pillText: { color: '#888888', fontSize: 14, fontWeight: '600' },
  pillTextActive: { color: '#FFFFFF' },

  saveBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
    minHeight: 56,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  scheduleBtn: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  scheduleBtnText: { color: '#DC143C', fontSize: 15, fontWeight: '700' },

  dangerBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DC143C',
    minHeight: 52,
    justifyContent: 'center',
  },
  dangerBtnText: { color: '#DC143C', fontSize: 15, fontWeight: '700' },

  mutedBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 52,
    justifyContent: 'center',
  },
  mutedBtnText: { color: '#888888', fontSize: 15, fontWeight: '600' },

  errorText: { color: '#888888', fontSize: 15, textAlign: 'center', marginBottom: 24 },
  retryBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
  },
  retryBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  memberInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  memberAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  memberName: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  memberCallsign: { color: '#888888', fontSize: 12, marginTop: 2 },
  transferArrow: { color: '#DC143C', fontSize: 20, fontWeight: '700', paddingLeft: 8 },

  announcementInput: {
    color: '#FFFFFF',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 10,
    padding: 12,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 8,
  },
  charCount: { color: '#555', fontSize: 11, textAlign: 'right', marginBottom: 12 },
  announceBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  announceBtnDisabled: { opacity: 0.4 },
  announceBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});

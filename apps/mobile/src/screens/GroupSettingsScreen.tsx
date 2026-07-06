import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { useTheme, ThemeColors } from '../theme';

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

interface JoinRequest {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  callsign: string | null;
  createdAt: string;
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
  // Uses its own theme lookup (rather than the screen's `styles`) since this
  // component is defined at module scope and reused independently of the
  // screen's themed StyleSheet instance.
  const { colors } = useTheme();
  return (
    <View style={pillSelectorStyles.pillRow}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={String(opt.value)}
            style={[
              pillSelectorStyles.pill,
              { backgroundColor: colors.bg, borderColor: colors.border },
              active && { backgroundColor: colors.accent, borderColor: colors.accent },
              disabled && pillSelectorStyles.pillDisabled,
            ]}
            onPress={() => { if (!disabled) onSelect(opt.value); }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[pillSelectorStyles.pillText, { color: active ? colors.text : colors.textMuted }]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// Dimensions-only (no color) — colors are applied inline above via useTheme()
const pillSelectorStyles = StyleSheet.create({
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 100, borderWidth: 1 },
  pillDisabled: { opacity: 0.4 },
  pillText: { fontSize: 14, fontWeight: '600' },
});

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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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

  // Join requests state (invite-only groups, admin only)
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [actingRequest, setActingRequest] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);

  // Announcement state
  const [announcement, setAnnouncement] = useState('');
  const [sendingAnnouncement, setSendingAnnouncement] = useState(false);

  const loadSettings = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, membersRes, joinRequestsRes] = await Promise.all([
        apiClient.get<GroupSettings>(`/api/v1/groups/${groupId}`),
        isAdmin
          ? apiClient.get<{ members: GroupMember[] }>(`/api/v1/groups/${groupId}/members`)
          : Promise.resolve(null),
        isAdmin
          ? apiClient.get<{ requests: JoinRequest[] }>(`/api/v1/groups/${groupId}/join-requests`).catch(() => null)
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
      if (joinRequestsRes) {
        setJoinRequests(joinRequestsRes.data.requests);
      }
    } catch {
      setError('Could not load group settings. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [groupId, isAdmin]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const handleJoinRequestAction = async (requestId: string, action: 'approve' | 'reject') => {
    if (!groupId) return;
    setActingRequest({ id: requestId, action });
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/join-requests/${requestId}/${action}`);
      setJoinRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch {
      Alert.alert('Error', `Failed to ${action} request. Please try again.`);
    } finally {
      setActingRequest(null);
    }
  };

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
              await apiClient.post(`/api/v1/groups/${groupId}/end`);
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
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button">
            <Text style={styles.backBtnText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Group Settings</Text>
        </View>
        <View style={{ padding: 16, gap: 14 }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ gap: 8 }}>
              <SkeletonBox width="30%" height={11} />
              <SkeletonBox width="100%" height={48} borderRadius={10} />
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  // ---- Error ----
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button">
            <Text style={styles.backBtnText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Group Settings</Text>
        </View>
        <NetworkError onRetry={() => void loadSettings()} message={error} />
      </SafeAreaView>
    );
  }

  const readOnly = !isAdmin;

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button">
          <Text style={styles.backBtnText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
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
            placeholderTextColor={colors.textSubtle}
            editable={!readOnly}
            maxLength={60}
            returnKeyType="done"
            accessibilityLabel="Group name"
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
              ? <ActivityIndicator color={colors.text} size="small" />
              : <Text style={styles.saveBtnText}>Save Changes</Text>}
          </TouchableOpacity>
        )}

        {/* Join Requests (admin only, invite-only groups) */}
        {isAdmin && joinRequests.length > 0 && (
          <>
            <Text style={[styles.sectionHeader, { marginTop: 32 }]}>
              JOIN REQUESTS ({joinRequests.length})
            </Text>
            <View style={styles.card}>
              {joinRequests.map((r) => {
                const isActing = actingRequest?.id === r.id;
                return (
                  <View key={r.id} style={styles.memberRow}>
                    <View style={styles.memberInfo}>
                      <View style={styles.memberAvatar}>
                        <Text style={styles.memberAvatarText}>
                          {r.displayName.trim()[0]?.toUpperCase() ?? '?'}
                        </Text>
                      </View>
                      <View>
                        <Text style={styles.memberName}>{r.displayName}</Text>
                        {r.callsign ? (
                          <Text style={styles.memberCallsign}>
                            <Ionicons name="radio-outline" size={11} color={colors.textMuted} /> {r.callsign}
                          </Text>
                        ) : (
                          <Text style={styles.memberCallsign}>Wants to join</Text>
                        )}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        style={styles.acceptBtn}
                        onPress={() => { void handleJoinRequestAction(r.id, 'approve'); }}
                        disabled={isActing}
                        accessibilityRole="button"
                        accessibilityLabel={`Approve ${r.displayName}`}
                        accessibilityState={{ disabled: isActing }}
                      >
                        {isActing && actingRequest?.action === 'approve'
                          ? <ActivityIndicator color={colors.text} size="small" />
                          : <Ionicons name="checkmark" size={18} color={colors.text} />}
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.declineBtn}
                        onPress={() => { void handleJoinRequestAction(r.id, 'reject'); }}
                        disabled={isActing}
                        accessibilityRole="button"
                        accessibilityLabel={`Reject ${r.displayName}`}
                        accessibilityState={{ disabled: isActing }}
                      >
                        {isActing && actingRequest?.action === 'reject'
                          ? <ActivityIndicator color={colors.textMuted} size="small" />
                          : <Ionicons name="close" size={16} color={colors.textMuted} />}
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </View>
          </>
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
                <Text style={styles.scheduleBtnText}>
                  <Ionicons name="calendar-outline" size={14} color={colors.accent} /> Schedule a Convoy
                </Text>
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
                        <Text style={styles.memberCallsign}>
                          <Ionicons name="radio-outline" size={11} color={colors.textMuted} /> {m.pttCallsign}
                        </Text>
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
                placeholderTextColor={colors.textSubtle}
                multiline
                maxLength={200}
                returnKeyType="default"
                accessibilityLabel="Announcement message"
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
                  {sendingAnnouncement ? 'Sending...' : <><Ionicons name="megaphone-outline" size={14} color={colors.text} /> Send Announcement</>}
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: { paddingVertical: 8, paddingRight: 12, minHeight: 44, justifyContent: 'center' },
  backBtnText: { color: colors.accent, fontSize: 17, fontWeight: '500' },
  headerTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  adminBadge: {
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  adminBadgeText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },

  scrollContent: { paddingHorizontal: 16, paddingTop: 16 },

  sectionHeader: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 8,
    marginTop: 16,
  },

  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },

  settingLabel: { color: colors.textMuted, fontSize: 13, marginBottom: 12 },

  nameInput: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  inputDisabled: { opacity: 0.5 },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 100,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillDisabled: { opacity: 0.4 },
  pillText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  pillTextActive: { color: colors.text },

  saveBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
    minHeight: 56,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: colors.text, fontSize: 16, fontWeight: '700' },

  scheduleBtn: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  scheduleBtnText: { color: colors.accent, fontSize: 15, fontWeight: '700' },

  dangerBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    minHeight: 52,
    justifyContent: 'center',
  },
  dangerBtnText: { color: colors.accent, fontSize: 15, fontWeight: '700' },

  mutedBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 52,
    justifyContent: 'center',
  },
  mutedBtnText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },

  errorText: { color: colors.textMuted, fontSize: 15, textAlign: 'center', marginBottom: 24 },
  retryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
  },
  retryBtnText: { color: colors.text, fontSize: 15, fontWeight: '700' },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
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
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  memberName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  memberCallsign: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  transferArrow: { color: colors.accent, fontSize: 20, fontWeight: '700', paddingLeft: 8 },

  acceptBtn: { width: 38, height: 38, borderRadius: 8, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
  acceptBtnTxt: { color: colors.text, fontSize: 16, fontWeight: '700' },
  declineBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  declineBtnTxt: { color: colors.textMuted, fontSize: 15, fontWeight: '700' },

  announcementInput: {
    color: colors.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 8,
  },
  charCount: { color: colors.textSubtle, fontSize: 11, textAlign: 'right', marginBottom: 12 },
  announceBtn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  announceBtnDisabled: { opacity: 0.4 },
  announceBtnText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  });
}

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';

interface MemberInfo {
  userId: string;
  displayName: string;
  callsign: string | null;
  isAdmin: boolean;
  isOnline: boolean;
  speedKph?: number;
  distanceM?: number;
  isMuted?: boolean;
}

interface Props {
  visible: boolean;
  member: MemberInfo | null;
  isCurrentUserAdmin: boolean;
  onClose: () => void;
  onMute?: (userId: string, mute: boolean) => void;
  onKick?: (userId: string) => void;
  onNavigateTo?: (userId: string) => void;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

export default function MemberDetailModal({
  visible,
  member,
  isCurrentUserAdmin,
  onClose,
  onMute,
  onKick,
  onNavigateTo,
}: Props) {
  if (!member) return null;

  const showAdminControls = isCurrentUserAdmin;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
      />

      <View style={styles.sheet}>
        {/* Drag handle */}
        <View style={styles.handle} />

        {/* Avatar */}
        <View style={[styles.avatar, { backgroundColor: member.isAdmin ? '#DC143C' : '#1C1C1C' }]}>
          <Text style={styles.avatarText}>{initials(member.displayName)}</Text>
        </View>

        {/* Name */}
        <Text style={styles.name} numberOfLines={1}>{member.displayName}</Text>

        {/* Callsign badge */}
        <View style={styles.callsignBadge}>
          <Text style={styles.callsignText}>
            {member.callsign ? `📻 ${member.callsign}` : 'No callsign'}
          </Text>
        </View>

        {/* Online status */}
        <Text style={[styles.status, { color: member.isOnline ? '#22C55E' : '#555555' }]}>
          {member.isOnline ? '🟢 Online' : '⚫ Offline'}
        </Text>

        {/* Stats row */}
        <View style={styles.statsRow}>
          {member.speedKph !== undefined && (
            <View style={styles.statPill}>
              <Text style={styles.statText}>🚗 {Math.round(member.speedKph)} km/h</Text>
            </View>
          )}
          {member.distanceM !== undefined && (
            <View style={styles.statPill}>
              <Text style={styles.statText}>📏 {formatDistance(member.distanceM)} behind</Text>
            </View>
          )}
          {member.isMuted && (
            <View style={[styles.statPill, styles.mutedPill]}>
              <Text style={styles.statText}>🔇 Muted</Text>
            </View>
          )}
        </View>

        {/* Admin controls */}
        {showAdminControls && (
          <View style={styles.adminSection}>
            <View style={styles.adminRow}>
              <TouchableOpacity
                style={styles.outlineBtn}
                onPress={() => onMute?.(member.userId, !member.isMuted)}
                accessibilityRole="button"
              >
                <Text style={styles.outlineBtnText}>
                  {member.isMuted ? '🔊 Unmute' : '🔇 Mute'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.outlineBtn}
                onPress={() => { onNavigateTo?.(member.userId); onClose(); }}
                accessibilityRole="button"
              >
                <Text style={styles.outlineBtnText}>🗺️ Navigate to</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.kickBtn}
              onPress={() => onKick?.(member.userId)}
              accessibilityRole="button"
            >
              <Text style={styles.kickBtnText}>Remove from group</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Close */}
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} accessibilityRole="button">
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 36,
    alignItems: 'center',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#3A3A3A',
    borderRadius: 2,
    marginBottom: 20,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  name: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  callsignBadge: {
    backgroundColor: '#0A0A0A',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 10,
  },
  callsignText: {
    color: '#888888',
    fontSize: 13,
    fontWeight: '600',
  },
  status: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginBottom: 20,
  },
  statPill: {
    backgroundColor: '#0A0A0A',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mutedPill: {
    borderColor: '#DC143C',
  },
  statText: {
    color: '#FFFFFF',
    fontSize: 13,
  },
  adminSection: {
    width: '100%',
    gap: 10,
    marginBottom: 16,
  },
  adminRow: {
    flexDirection: 'row',
    gap: 10,
  },
  outlineBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  outlineBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  kickBtn: {
    width: '100%',
    paddingVertical: 12,
    alignItems: 'center',
  },
  kickBtnText: {
    color: '#DC143C',
    fontSize: 14,
    fontWeight: '600',
  },
  closeBtn: {
    width: '100%',
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  closeBtnText: {
    color: '#888888',
    fontSize: 15,
    fontWeight: '600',
  },
});

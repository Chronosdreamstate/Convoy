import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  groupName: string;
  memberCount: number;
  onlineCount: number;
  isAdmin: boolean;
  onPressSettings?: () => void;
  onPressMembers?: () => void;
}

function ConvoyStatusPanel({
  groupName,
  memberCount,
  onlineCount,
  isAdmin,
  onPressSettings,
  onPressMembers,
}: Props) {
  const truncatedName = groupName.length > 16 ? groupName.slice(0, 14) + '…' : groupName;

  return (
    <View style={styles.container}>
      {/* Group name */}
      <View style={styles.left}>
        <Text style={styles.nameText} numberOfLines={1}>🚗 {truncatedName}</Text>
      </View>

      {/* Member count */}
      <TouchableOpacity
        style={styles.center}
        onPress={onPressMembers}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel={`${onlineCount} of ${memberCount} members online`}
      >
        <Text style={styles.membersText}>👥 {onlineCount}/{memberCount}</Text>
      </TouchableOpacity>

      {/* Actions */}
      <View style={styles.right}>
        {onPressMembers && (
          <TouchableOpacity
            onPress={onPressMembers}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="View members"
          >
            <Text style={styles.icon}>👥</Text>
          </TouchableOpacity>
        )}
        {isAdmin && onPressSettings && (
          <TouchableOpacity
            onPress={onPressSettings}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="Group settings"
          >
            <Text style={styles.icon}>⚙️</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(28,28,28,0.9)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    height: 40,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 6,
    borderWidth: 1,
    borderColor: 'rgba(42,42,42,0.6)',
  },
  left: {
    flex: 1,
  },
  nameText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  center: {
    paddingHorizontal: 8,
  },
  membersText: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '600',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: {
    fontSize: 16,
  },
});

ConvoyStatusPanel.displayName = 'ConvoyStatusPanel';

export default React.memo(ConvoyStatusPanel);

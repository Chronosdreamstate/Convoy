import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, shadowStyle, useTheme, withAlpha } from '../theme';

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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const truncatedName = groupName.length > 16 ? groupName.slice(0, 14) + '…' : groupName;

  return (
    <View style={styles.container}>
      {/* Group name */}
      <View style={styles.left}>
        <Ionicons name="car" size={14} color={colors.accent} style={styles.groupIcon} />
        <Text style={styles.nameText} numberOfLines={1}>{truncatedName}</Text>
      </View>

      {/* Member count */}
      <TouchableOpacity
        style={styles.center}
        onPress={onPressMembers}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel={`${onlineCount} of ${memberCount} members online`}
      >
        <Ionicons name="people" size={14} color={colors.textMuted} />
        <Text style={styles.membersText}>{onlineCount}/{memberCount}</Text>
      </TouchableOpacity>

      {/* Actions */}
      <View style={styles.right}>
        {onPressMembers && (
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onPressMembers}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="View members"
          >
            <Ionicons name="people-outline" size={18} color={colors.text} />
          </TouchableOpacity>
        )}
        {isAdmin && onPressSettings && (
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onPressSettings}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="Group settings"
          >
            <Ionicons name="settings-outline" size={18} color={colors.text} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: withAlpha(colors.cardElevated, 0.92),
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 8,
      minHeight: 40,
      borderWidth: 1,
      borderColor: withAlpha(colors.border, 0.6),
      ...shadowStyle(6),
    },
    left: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
    },
    groupIcon: {
      marginRight: 6,
    },
    nameText: {
      flex: 1,
      color: colors.text,
      fontSize: 13,
      fontWeight: '700',
    },
    center: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 8,
    },
    membersText: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '600',
    },
    right: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    iconBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}

ConvoyStatusPanel.displayName = 'ConvoyStatusPanel';

export default React.memo(ConvoyStatusPanel);

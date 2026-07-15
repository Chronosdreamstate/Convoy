import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { ThemeColors, useTheme } from '../theme';

interface Props {
  groupName: string;
  memberCount: number;
  isAdmin: boolean;
  onPress: () => void;
  onEndConvoy?: () => void;
}

function ConvoyBanner({
  groupName,
  memberCount,
  isAdmin,
  onPress,
  onEndConvoy,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const slideAnim = useRef(new Animated.Value(-60)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    // Shown over the map while driving — snap into place under OS reduce-motion.
    if (reduceMotion) {
      slideAnim.setValue(0);
      return;
    }
    Animated.spring(slideAnim, {
      toValue: 0,
      damping: 18,
      stiffness: 160,
      useNativeDriver: true,
    }).start();
  }, [slideAnim, reduceMotion]);

  return (
    <Animated.View
      style={[
        styles.wrapper,
        { top: insets.top + 8, transform: [{ translateY: slideAnim }] },
      ]}
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
    >
      <TouchableOpacity
        style={styles.pill}
        onPress={onPress}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Convoy active: ${groupName}, ${memberCount} riders`}
      >
        {/* This pill's background is a fixed dark translucent chip regardless of
            app theme (it floats over the map at the top of the screen), so its
            icon/text below stay fixed light/gray rather than following the theme. */}
        <Ionicons name="car" size={16} color="#FFFFFF" style={styles.icon} />
        <Text style={styles.groupName} numberOfLines={1}>
          {groupName}
        </Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.count}>{memberCount} riders</Text>

        {isAdmin ? (
          <TouchableOpacity
            style={styles.endBtn}
            onPress={onEndConvoy}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="End convoy"
          >
            <Text style={styles.endBtnText}>END</Text>
          </TouchableOpacity>
        ) : (
          <Ionicons name="chevron-forward" size={16} color="#888888" />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const MemoConvoyBanner = React.memo(ConvoyBanner);
MemoConvoyBanner.displayName = 'ConvoyBanner';
export default MemoConvoyBanner;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrapper: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      zIndex: 100,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 44,
      maxWidth: 360,
      width: '90%',
      backgroundColor: 'rgba(28,28,28,0.93)',
      borderRadius: 22,
      borderWidth: 1,
      borderColor: '#2A2A2A',
      paddingHorizontal: 14,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.45,
      shadowRadius: 8,
      elevation: 8,
    },
    icon: {
      marginRight: 6,
    },
    groupName: {
      flex: 1,
      fontSize: 14,
      fontWeight: '700',
      color: '#FFFFFF',
    },
    dot: {
      fontSize: 14,
      color: '#555555',
      marginHorizontal: 6,
    },
    count: {
      fontSize: 13,
      color: '#888888',
      marginRight: 8,
    },
    endBtn: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    endBtnText: {
      color: '#FFFFFF',
      fontSize: 11,
      fontWeight: '800',
      letterSpacing: 0.5,
    },
  });
}

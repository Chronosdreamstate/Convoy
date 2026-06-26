import React, { useEffect, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const slideAnim = useRef(new Animated.Value(-60)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      damping: 18,
      stiffness: 160,
      useNativeDriver: true,
    }).start();
  }, [slideAnim]);

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
        <Text style={styles.icon}>🚗</Text>
        <Text style={styles.groupName} numberOfLines={1}>
          {groupName}
        </Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.count}>{memberCount} riders</Text>

        {isAdmin ? (
          <TouchableOpacity
            style={styles.endBtn}
            onPress={onEndConvoy}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="End convoy"
          >
            <Text style={styles.endBtnText}>END</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.chevron}>›</Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const MemoConvoyBanner = React.memo(ConvoyBanner);
MemoConvoyBanner.displayName = 'ConvoyBanner';
export default MemoConvoyBanner;

const styles = StyleSheet.create({
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
    fontSize: 16,
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
  chevron: {
    fontSize: 18,
    color: '#888888',
    lineHeight: 22,
  },
  endBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  endBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});

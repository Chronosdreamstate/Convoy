import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../theme';

interface Props {
  isOffline: boolean;
  message?: string;
}

const DEFAULT_MSG = 'No internet connection — changes will sync when back online';
const BACK_ONLINE_MSG = 'Back online';
const BANNER_H = 40;

export default function OfflineIndicator({ isOffline, message = DEFAULT_MSG }: Props) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  // On-fill color for the banner text/icon. The success/warning fills are BRIGHT
  // in dark mode (black reads well) but DARK in light mode (#11813B / #B45309,
  // where black fails contrast) — so flip to white in light mode.
  const onFill = isDark ? '#000000' : '#FFFFFF';
  // Total on-screen height including the safe-area inset — previously this banner
  // used a hardcoded `top: 0` with no inset padding, so on notched / Dynamic-Island
  // devices its text rendered partly underneath the status bar / sensor housing
  // instead of below it (the same bug MapScreen's local offline banner already
  // had fixed via insets.top).
  const totalHeight = BANNER_H + insets.top;
  const translateY = useRef(new Animated.Value(-BANNER_H)).current;
  const [visible, setVisible] = useState(false);
  const [showingOnline, setShowingOnline] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    if (isOffline) {
      setShowingOnline(false);
      setVisible(true);
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 200,
      }).start();
    } else if (visible) {
      // Was visible (offline), now back online — show green for 2s then hide
      setShowingOnline(true);
      hideTimer.current = setTimeout(() => {
        Animated.spring(translateY, {
          toValue: -totalHeight,
          useNativeDriver: true,
          damping: 20,
          stiffness: 200,
        }).start(({ finished }) => {
          if (finished) setVisible(false);
        });
      }, 2000);
    }

    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  // totalHeight intentionally omitted — insets are stable after first layout and
  // re-running this on every insets tick would restart the current animation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOffline]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        { paddingTop: insets.top },
        { backgroundColor: showingOnline ? colors.success : colors.warning },
        { transform: [{ translateY }] },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={showingOnline ? BACK_ONLINE_MSG : message}
    >
      <View style={styles.content}>
        <MaterialCommunityIcons
          name={showingOnline ? 'wifi' : 'wifi-off'}
          size={16}
          color={onFill}
        />
        <Text style={[styles.text, { color: onFill }]} numberOfLines={1}>
          {showingOnline ? BACK_ONLINE_MSG : message}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    minHeight: BANNER_H,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    paddingHorizontal: 16,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  text: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});

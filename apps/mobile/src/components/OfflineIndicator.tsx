import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

interface Props {
  isOffline: boolean;
  message?: string;
}

const DEFAULT_MSG = 'No internet connection — changes will sync when back online';
const BACK_ONLINE_MSG = 'Back online ✓';
const BANNER_H = 40;

export default function OfflineIndicator({ isOffline, message = DEFAULT_MSG }: Props) {
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
          toValue: -BANNER_H,
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
  }, [isOffline]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        showingOnline ? styles.bannerOnline : styles.bannerOffline,
        { transform: [{ translateY }] },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={showingOnline ? BACK_ONLINE_MSG : message}
    >
      <Text style={styles.text} numberOfLines={1}>
        {showingOnline ? `📶 ${BACK_ONLINE_MSG}` : `📡 ${message}`}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: BANNER_H,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    paddingHorizontal: 16,
  },
  bannerOffline: {
    backgroundColor: '#F59E0B',
  },
  bannerOnline: {
    backgroundColor: '#22C55E',
  },
  text: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});

/**
 * AsyncListState — one place to render the loading / empty / error+retry states
 * that every data-fetching list screen needs.
 *
 * This exists because the same bug kept recurring across screens: when a fetch
 * failed, the list would fall through to its "empty" branch and silently show a
 * false "Nothing here yet" — hiding the failure and giving the user no way to
 * recover. AsyncListState makes the error state (with a Retry button) take
 * precedence over the empty state, so a load failure can never masquerade as
 * empty data.
 *
 * Precedence: loading → error → empty → children. `error` is checked before
 * `isEmpty` on purpose — that ordering is the whole point of the component.
 *
 * Usage:
 *   <AsyncListState
 *     loading={query.isLoading}
 *     error={query.error}
 *     isEmpty={items.length === 0}
 *     onRetry={query.refetch}
 *     emptyTitle="No groups yet"
 *     emptyMessage="Join or create a group to get rolling."
 *     emptyIcon="people-outline"
 *   >
 *     <FlatList data={items} ... />
 *   </AsyncListState>
 */

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, useTheme } from '../theme';

type IoniconName = keyof typeof Ionicons.glyphMap;

interface Props {
  /** Fetch is in flight and there is nothing to show yet. */
  loading: boolean;
  /** Non-null when the fetch failed. Anything truthy triggers the error state. */
  error: unknown;
  /** True when the fetch succeeded but returned no items. */
  isEmpty: boolean;
  /** Re-run the fetch. Wired to the error state's Retry button. */
  onRetry: () => void;

  /** Loaded content — rendered only when not loading, no error, and not empty. */
  children: React.ReactNode;

  // Empty-state slots -------------------------------------------------------
  emptyTitle?: string;
  emptyMessage?: string;
  emptyIcon?: IoniconName;

  // Error-state slots (sensible defaults; override per screen if useful) ----
  errorTitle?: string;
  errorMessage?: string;
  errorIcon?: IoniconName;
  retryLabel?: string;

  /**
   * Override the default centered spinner (e.g. pass a stack of SkeletonCard
   * placeholders). When omitted, a theme-tinted ActivityIndicator is shown.
   */
  loadingContent?: React.ReactNode;
  /** Accessibility label announced while loading. */
  loadingLabel?: string;
}

export default function AsyncListState({
  loading,
  error,
  isEmpty,
  onRetry,
  children,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
  emptyIcon = 'file-tray-outline',
  errorTitle = 'Something went wrong',
  errorMessage = "We couldn't load this. Check your connection and try again.",
  errorIcon = 'cloud-offline-outline',
  retryLabel = 'Try again',
  loadingContent,
  loadingLabel = 'Loading',
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // 1. Loading — highest precedence so a background refetch shows progress
  //    rather than flashing a stale error/empty frame.
  if (loading) {
    if (loadingContent) {
      return <>{loadingContent}</>;
    }
    return (
      <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={loadingLabel}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // 2. Error — checked BEFORE empty so a failed load can never render as a
  //    false "empty" state. Always offers a way to recover.
  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name={errorIcon} size={48} color={colors.textMuted} accessible={false} />
        <Text style={styles.title}>{errorTitle}</Text>
        {!!errorMessage && <Text style={styles.message}>{errorMessage}</Text>}
        <TouchableOpacity
          onPress={onRetry}
          style={styles.retryButton}
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
        >
          <Ionicons name="refresh" size={16} color="#FFFFFF" accessible={false} />
          <Text style={styles.retryText}>{retryLabel}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // 3. Empty — a genuine "loaded, but no data" state.
  if (isEmpty) {
    return (
      <View style={styles.center}>
        <Ionicons name={emptyIcon} size={48} color={colors.textSubtle} accessible={false} />
        <Text style={styles.title}>{emptyTitle}</Text>
        {!!emptyMessage && <Text style={styles.message}>{emptyMessage}</Text>}
      </View>
    );
  }

  // 4. Loaded content.
  return <>{children}</>;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      paddingVertical: 48,
    },
    title: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '700',
      textAlign: 'center',
      marginTop: 16,
    },
    message: {
      color: colors.textMuted,
      fontSize: 14,
      textAlign: 'center',
      lineHeight: 20,
      marginTop: 8,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 8,
      marginTop: 24,
      minHeight: 44,
    },
    // The Retry button's background is the fixed-value accent color (identical
    // in both themes), so its label/icon stay fixed white for contrast.
    retryText: {
      color: '#FFFFFF',
      fontWeight: '700',
      fontSize: 15,
    },
  });
}

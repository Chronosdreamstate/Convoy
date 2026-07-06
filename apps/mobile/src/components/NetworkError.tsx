import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Button from './Button';
import { useTheme } from '../theme';

interface Props {
  onRetry: () => void;
  message?: string;
}

export function NetworkError({ onRetry, message = 'Could not connect to server' }: Props) {
  const { colors, spacing, typography } = useTheme();

  return (
    <View
      style={[styles.container, { backgroundColor: colors.bg, padding: spacing.xl }]}
      accessibilityRole="alert"
    >
      <Text style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">
        📡
      </Text>
      <Text style={[styles.title, typography.heading, { color: colors.text, marginBottom: spacing.sm }]}>
        No Connection
      </Text>
      <Text
        style={[
          styles.message,
          typography.body,
          { color: colors.textMuted, marginBottom: spacing.lg },
        ]}
      >
        {message}
      </Text>
      <Button label="Try Again" variant="primary" onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { textAlign: 'center' },
  message: { textAlign: 'center' },
});

import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableOpacityProps,
  ViewStyle,
} from 'react-native';
import { theme } from '../theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props extends Omit<TouchableOpacityProps, 'style'> {
  label: string;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
}

export default function Button({
  label,
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  style,
  ...rest
}: Props) {
  const isDisabled = disabled ?? loading;

  return (
    <TouchableOpacity
      {...rest}
      disabled={isDisabled}
      activeOpacity={0.75}
      style={[
        styles.base,
        styles[variant],
        styles[`size_${size}`],
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
        style,
      ]}
      hitSlop={theme.hitSlop}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'secondary' || variant === 'ghost' ? theme.colors.accent : theme.colors.text}
        />
      ) : (
        <Text style={[styles.label, styles[`label_${variant}`], styles[`labelSize_${size}`]]}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  fullWidth: {
    width: '100%',
  },
  disabled: {
    opacity: 0.45,
  },

  // Variants
  primary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  secondary: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  danger: {
    backgroundColor: theme.colors.error,
    borderColor: theme.colors.error,
  },

  // Sizes
  size_sm: { paddingHorizontal: theme.spacing.md, paddingVertical: 6, minHeight: 36 },
  size_md: { paddingHorizontal: theme.spacing.lg, paddingVertical: 12 },
  size_lg: { paddingHorizontal: theme.spacing.xl, paddingVertical: 16, minHeight: 52 },

  // Labels
  label: {
    fontWeight: '700',
  },
  label_primary: { color: theme.colors.text },
  label_secondary: { color: theme.colors.text },
  label_ghost: { color: theme.colors.accent },
  label_danger: { color: theme.colors.text },

  labelSize_sm: { fontSize: 13 },
  labelSize_md: { fontSize: 15, letterSpacing: 0.2 },
  labelSize_lg: { fontSize: 17, letterSpacing: 0.3 },
});

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableOpacityProps,
  ViewStyle,
} from 'react-native';
import { ThemeColors, useTheme } from '../theme';

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
  const { colors, spacing, radius, hitSlop } = useTheme();
  const styles = useMemo(() => makeStyles(colors, spacing, radius), [colors, spacing, radius]);
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
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'secondary' || variant === 'ghost' ? colors.accent : '#FFFFFF'}
        />
      ) : (
        <Text style={[styles.label, styles[`label_${variant}`], styles[`labelSize_${size}`]]}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function makeStyles(colors: ThemeColors, spacing: { md: number; lg: number; xl: number }, radius: { md: number }) {
  return StyleSheet.create({
    base: {
      borderRadius: radius.md,
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
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    secondary: {
      backgroundColor: colors.card,
      borderColor: colors.border,
    },
    ghost: {
      backgroundColor: 'transparent',
      borderColor: 'transparent',
    },
    danger: {
      backgroundColor: colors.error,
      borderColor: colors.error,
    },

    // Sizes
    size_sm: { paddingHorizontal: spacing.md, paddingVertical: 6, minHeight: 36 },
    size_md: { paddingHorizontal: spacing.lg, paddingVertical: 12 },
    size_lg: { paddingHorizontal: spacing.xl, paddingVertical: 16, minHeight: 52 },

    // Labels
    label: {
      fontWeight: '700',
    },
    // primary/danger sit on saturated accent/error fills — white stays legible
    // in both themes (colors.text is near-black in light mode). secondary is on
    // the card surface, so it correctly uses the theme text color.
    label_primary: { color: '#FFFFFF' },
    label_secondary: { color: colors.text },
    label_ghost: { color: colors.accent },
    label_danger: { color: '#FFFFFF' },

    labelSize_sm: { fontSize: 13 },
    labelSize_md: { fontSize: 15, letterSpacing: 0.2 },
    labelSize_lg: { fontSize: 17, letterSpacing: 0.3 },
  });
}

import { Platform, ViewStyle } from 'react-native';

export const theme = {
  colors: {
    bg: '#0A0A0A',
    card: '#1C1C1C',
    cardElevated: '#242424',
    border: '#2A2A2A',
    accent: '#DC143C',
    accentMuted: '#9B0D29',
    text: '#FFFFFF',
    textMuted: '#888888',
    textSubtle: '#555555',
    success: '#22C55E',
    warning: '#F59E0B',
    error: '#EF4444',
    info: '#3B82F6',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    pill: 100,
  },
  typography: {
    hero: { fontSize: 72, fontWeight: '900' as const, letterSpacing: 10 },
    title: { fontSize: 22, fontWeight: '700' as const },
    heading: { fontSize: 18, fontWeight: '700' as const },
    body: { fontSize: 16, fontWeight: '400' as const },
    label: { fontSize: 14, fontWeight: '600' as const },
    caption: { fontSize: 12, fontWeight: '400' as const },
    tiny: { fontSize: 11, fontWeight: '400' as const },
  },
  hitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
} as const;

export type Theme = typeof theme;

/** Cross-platform shadow. elevation=1 → subtle, 4 → prominent card, 8 → modal. */
export function shadowStyle(elevation: number): ViewStyle {
  if (Platform.OS === 'android') {
    return { elevation };
  }
  const opacity = Math.min(0.05 + elevation * 0.03, 0.35);
  const radius = elevation * 2;
  return {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: elevation },
    shadowOpacity: opacity,
    shadowRadius: radius,
  };
}

/** Base card style — use as a spread in StyleSheet.create. */
export function cardStyle(options?: { elevated?: boolean }): ViewStyle {
  const bg = options?.elevated ? theme.colors.cardElevated : theme.colors.card;
  return {
    backgroundColor: bg,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...shadowStyle(options?.elevated ? 4 : 2),
  };
}

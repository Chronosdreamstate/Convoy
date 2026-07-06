import React, { createContext, useContext, useMemo } from 'react';
import { Platform, useColorScheme, ViewStyle } from 'react-native';
import { useSettingsStore } from './stores/settingsStore';

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------
// `darkColors` is the app's original, only palette — every existing screen's
// hardcoded hex literals (e.g. '#0A0A0A', '#1C1C1C') were copied from these
// exact values. `lightColors` mirrors the same semantic roles (bg/card/text/
// accent/etc.) so screens can migrate to `useTheme()` incrementally without
// a visual change under the default (dark) mode.

export interface ThemeColors {
  bg: string;
  card: string;
  cardElevated: string;
  border: string;
  accent: string;
  accentMuted: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

const darkColors: ThemeColors = {
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
};

const lightColors: ThemeColors = {
  bg: '#F7F7F8',
  card: '#FFFFFF',
  cardElevated: '#FFFFFF',
  border: '#8A8A8C',
  accent: '#DC143C',
  accentMuted: '#FDF2F5',
  text: '#0A0A0A',
  textMuted: '#6B6B6E',
  textSubtle: '#707075',
  success: '#11813B',
  warning: '#B45309',
  error: '#DC2626',
  info: '#2563EB',
};
export type ThemeMode = 'light' | 'dark' | 'system';

const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;
const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 100 } as const;
const typography = {
  hero: { fontSize: 72, fontWeight: '900' as const, letterSpacing: 10 },
  title: { fontSize: 22, fontWeight: '700' as const },
  heading: { fontSize: 18, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  label: { fontSize: 14, fontWeight: '600' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  tiny: { fontSize: 11, fontWeight: '400' as const },
} as const;
const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 } as const;

/**
 * Static, default-dark theme object — kept for backward compatibility with
 * every screen written before the light/dark system existed (they `import
 * { theme } from '../theme'` and read `theme.colors.X` directly, with no
 * awareness of scheme). New/converted screens should use `useTheme()`
 * instead, which resolves to the user's actual light/dark preference.
 */
export const theme = {
  colors: darkColors,
  spacing,
  radius,
  typography,
  hitSlop,
} as const;

export type Theme = typeof theme;

// ---------------------------------------------------------------------------
// Theme context — resolves system/user preference to a concrete palette
// ---------------------------------------------------------------------------

interface ThemeContextValue {
  colors: ThemeColors;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  hitSlop: typeof hitSlop;
  isDark: boolean;
  mode: ThemeMode;
}

const ThemeContext = createContext<ThemeContextValue>({
  colors: darkColors,
  spacing,
  radius,
  typography,
  hitSlop,
  isDark: true,
  mode: 'system',
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const mode = useSettingsStore((s) => s.themeMode);

  const value = useMemo<ThemeContextValue>(() => {
    const resolvedDark = mode === 'system' ? systemScheme !== 'light' : mode === 'dark';
    return {
      colors: resolvedDark ? darkColors : lightColors,
      spacing,
      radius,
      typography,
      hitSlop,
      isDark: resolvedDark,
      mode,
    };
  }, [mode, systemScheme]);

  return React.createElement(ThemeContext.Provider, { value }, children);
}

/** Resolves to the user's actual light/dark palette — prefer this over the static `theme` export in new/converted screens. */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

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

/** Base card style — use as a spread in StyleSheet.create. Pass `colors` from useTheme() for scheme-awareness; defaults to dark. */
export function cardStyle(options?: { elevated?: boolean; colors?: ThemeColors }): ViewStyle {
  const c = options?.colors ?? darkColors;
  const bg = options?.elevated ? c.cardElevated : c.card;
  return {
    backgroundColor: bg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    ...shadowStyle(options?.elevated ? 4 : 2),
  };
}

/**
 * Derives a translucent tint from a theme color (e.g. `withAlpha(colors.accent, 0.15)`)
 * instead of hardcoding a separate `rgba(...)` literal per screen. Accepts `#RGB` or
 * `#RRGGBB` hex; alpha is clamped to [0, 1].
 */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h.split('').map((ch) => ch + ch).join('');
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

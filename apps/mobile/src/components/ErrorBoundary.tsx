import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../theme';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <View style={styles.container}>
        <Text style={styles.emoji}>💥</Text>
        <Text style={styles.wordmark}>CORTEGE</Text>
        <Text style={styles.title}>Something went wrong</Text>
        {__DEV__ && this.state.error && (
          <Text style={styles.message}>{this.state.error.message}</Text>
        )}
        <TouchableOpacity
          style={styles.button}
          onPress={() => this.setState({ hasError: false, error: null })}
          accessibilityRole="button"
          accessibilityLabel="Try Again"
        >
          <Text style={styles.buttonText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.supportLink}
          onPress={() => Linking.openURL('mailto:support@convoy.app')}
          accessibilityRole="link"
        >
          <Text style={styles.supportText}>Contact Support</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

export function withErrorBoundary<T extends object>(
  Component: React.ComponentType<T>,
): React.ComponentType<T> {
  return function WrappedWithErrorBoundary(props: T) {
    return (
      <ErrorBoundary>
        <Component {...props} />
      </ErrorBoundary>
    );
  };
}

// Note: this is a class component (error boundaries require componentDidCatch,
// which has no hook equivalent), so it can't call useTheme(). It renders the
// static (dark) `theme` palette rather than duplicating hex literals — if the
// app ever needs this screen to follow light/dark preference too, wire
// ThemeContext up as a static contextType instead of hardcoding a palette here.
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
  emoji: {
    fontSize: 48,
    marginBottom: theme.spacing.sm,
  },
  wordmark: {
    color: theme.colors.accent,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 6,
    marginBottom: theme.spacing.md,
  },
  title: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
    textAlign: 'center',
  },
  message: {
    color: theme.colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.xl,
    marginTop: theme.spacing.lg,
  },
  buttonText: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  supportLink: {
    marginTop: theme.spacing.md,
    padding: theme.spacing.sm,
  },
  supportText: {
    color: theme.colors.textMuted,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
});

import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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
        <Text style={styles.wordmark}>CONVOY</Text>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 8,
  },
  wordmark: {
    color: '#DC143C',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 6,
    marginBottom: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    color: '#888888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginTop: 24,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  supportLink: {
    marginTop: 16,
    padding: 8,
  },
  supportText: {
    color: '#888888',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
});

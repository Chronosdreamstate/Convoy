import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  onRetry: () => void;
  message?: string;
}

export function NetworkError({ onRetry, message = 'Could not connect to server' }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📡</Text>
      <Text style={styles.title}>No Connection</Text>
      <Text style={styles.message}>{message}</Text>
      <TouchableOpacity onPress={onRetry} style={styles.button} accessibilityRole="button">
        <Text style={styles.buttonText}>Try Again</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#0A0A0A',
  },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 18, color: '#fff', fontWeight: '700', marginBottom: 8 },
  message: { fontSize: 14, color: '#888', textAlign: 'center', marginBottom: 24 },
  button: {
    backgroundColor: '#DC143C',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});

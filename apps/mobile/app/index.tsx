import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';

export default function Index() {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Text style={styles.wordmark}>CONVOY</Text>
        <View style={styles.accent} />
        <ActivityIndicator size="small" color="#DC143C" style={styles.spinner} />
      </View>
    );
  }

  if (isAuthenticated) {
    return <Redirect href="/(tabs)/map" />;
  }

  return <Redirect href="/(auth)/welcome" />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A0A0A',
  },
  wordmark: {
    color: '#F0F0F0',
    fontSize: 40,
    fontWeight: '900',
    letterSpacing: 8,
    marginBottom: 10,
  },
  accent: {
    width: 48,
    height: 2,
    backgroundColor: '#DC143C',
    borderRadius: 1,
    marginBottom: 28,
  },
  spinner: {
    opacity: 0.7,
  },
});

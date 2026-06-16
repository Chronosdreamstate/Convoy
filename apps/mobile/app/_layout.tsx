import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '../src/stores/authStore';

export default function RootLayout() {
  const { isAuthenticated, isLoading, setAccessToken, setLoading } = useAuthStore();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    (async () => {
      const token = await SecureStore.getItemAsync('convoy_access_token');
      if (token) setAccessToken(token);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (isLoading) return;
    const inAuth = segments[0] === '(auth)';
    if (!isAuthenticated && !inAuth) {
      router.replace('/(auth)/welcome');
    } else if (isAuthenticated && inAuth) {
      router.replace('/(tabs)/map');
    }
  }, [isAuthenticated, isLoading, segments]);

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </SafeAreaProvider>
  );
}

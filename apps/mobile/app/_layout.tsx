import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '../src/stores/authStore';
import { authService } from '../src/services/AuthService';
import { apiClient } from '../src/services/apiClient';

export default function RootLayout() {
  const { isAuthenticated, isLoading, setUser, setLoading, signOut: storeSignOut } = useAuthStore();
  const router = useRouter();

  // Startup: load stored token, refresh it, then fetch /me to hydrate the user
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const stored = await authService.loadStoredToken();
        if (!stored) { storeSignOut(); return; }
        const freshToken = await authService.refreshToken();
        if (!freshToken) { await authService.signOut(); return; }
        if (cancelled) return;
        const res = await apiClient.get('/api/v1/users/me');
        if (!cancelled) setUser(res.data);
      } catch {
        if (!cancelled) storeSignOut();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => { cancelled = true; };
  }, []);

  // Navigation guard: redirect unauthenticated users to welcome screen
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace('/(auth)/welcome');
    }
  }, [isAuthenticated, isLoading]);

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </SafeAreaProvider>
  );
}

import { Redirect } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';

export default function Index() {
  const { isAuthenticated, isLoading } = useAuthStore();
  if (isLoading) return null;
  return <Redirect href={isAuthenticated ? '/(tabs)/map' : '/(auth)/welcome'} />;
}

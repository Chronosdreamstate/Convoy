import { Redirect } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';

// DEV: skip auth for testing
export default function Index() {
  return <Redirect href="/(tabs)/map" />;
}

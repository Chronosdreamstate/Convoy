import MapScreen from '../../src/screens/map/MapScreen';
import GuestMapScreen from '../../src/screens/map/GuestMapScreen';
import { useAuthStore } from '../../src/stores/authStore';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const SOCKET_URL = API_URL.replace(/^http/, 'ws');

export default function MapTab() {
  const { isAuthenticated, accessToken, user } = useAuthStore();

  if (!isAuthenticated || !accessToken || !user) {
    return <GuestMapScreen />;
  }

  return (
    <MapScreen
      groupId=""
      accessToken={accessToken}
      socketUrl={SOCKET_URL}
    />
  );
}

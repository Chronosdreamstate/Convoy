import MapScreen from '../../src/screens/map/MapScreen';
import GuestMapScreen from '../../src/screens/map/GuestMapScreen';
import { useAuthStore } from '../../src/stores/authStore';
import { useGroupStore } from '../../src/stores/groupStore';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const SOCKET_URL = API_URL.replace(/^http/, 'ws');

export default function MapTab() {
  const { isAuthenticated, accessToken } = useAuthStore();
  const activeGroupId = useGroupStore((s) => s.activeGroupId);

  // Not authenticated → explore mode (no group)
  if (!isAuthenticated) {
    return <GuestMapScreen />;
  }

  // Authenticated but not in an active group → explore mode
  if (!activeGroupId) {
    return <GuestMapScreen />;
  }

  // Authenticated and in an active group → live map
  return (
    <MapScreen
      groupId={activeGroupId}
      accessToken={accessToken ?? ''}
      socketUrl={SOCKET_URL}
    />
  );
}

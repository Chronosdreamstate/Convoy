import MapScreen from '../../src/screens/map/MapScreen';
import GuestMapScreen from '../../src/screens/map/GuestMapScreen';
import { useAuthStore } from '../../src/stores/authStore';
import { useGroupStore } from '../../src/stores/groupStore';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const SOCKET_URL = API_URL.replace(/^http/, 'ws');

export default function MapTab() {
  const { isAuthenticated, accessToken } = useAuthStore();
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const pttChannelId = useGroupStore((s) => s.pttChannelId);

  if (!isAuthenticated) return <GuestMapScreen />;
  if (!activeGroupId) return <GuestMapScreen />;

  return (
    <MapScreen
      groupId={activeGroupId}
      accessToken={accessToken ?? ''}
      socketUrl={SOCKET_URL}
      pttChannelId={pttChannelId ?? undefined}
    />
  );
}

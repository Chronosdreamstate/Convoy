import MapScreen from '../../src/screens/map/MapScreen';
import GuestMapScreen from '../../src/screens/map/GuestMapScreen';
import IdleMapScreen from '../../src/screens/map/IdleMapScreen';
import { useAuthStore } from '../../src/stores/authStore';
import { useGroupStore } from '../../src/stores/groupStore';
import { withErrorBoundary } from '../../src/components/ErrorBoundary';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const SOCKET_URL = API_URL.replace(/^http/, 'ws');

function MapTab() {
  const { isAuthenticated, accessToken } = useAuthStore();
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const pttChannelId = useGroupStore((s) => s.pttChannelId);

  if (!isAuthenticated) return <GuestMapScreen />;
  if (!activeGroupId) return <IdleMapScreen />;

  return (
    <MapScreen
      groupId={activeGroupId}
      accessToken={accessToken ?? ''}
      socketUrl={SOCKET_URL}
      pttChannelId={pttChannelId ?? undefined}
    />
  );
}

export default withErrorBoundary(MapTab);

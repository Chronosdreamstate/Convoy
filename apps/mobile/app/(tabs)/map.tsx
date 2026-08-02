import MapScreen from '../../src/screens/map/MapScreen';
import GuestMapScreen from '../../src/screens/map/GuestMapScreen';
import IdleMapScreen from '../../src/screens/map/IdleMapScreen';
import { useAuthStore } from '../../src/stores/authStore';
import { useGroupStore } from '../../src/stores/groupStore';
import { withErrorBoundary } from '../../src/components/ErrorBoundary';
import { API_URL } from '../../src/config/env';

// http -> ws, https -> wss. This is the convoy's live-location socket, so it
// has to follow the same configured host as every REST call rather than keep
// its own copy of the fallback.
const SOCKET_URL = API_URL.replace(/^http/, 'ws');

function MapTab() {
  const { isAuthenticated } = useAuthStore();
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const pttChannelId = useGroupStore((s) => s.pttChannelId);

  if (!isAuthenticated) return <GuestMapScreen />;
  if (!activeGroupId) return <IdleMapScreen />;

  return (
    <MapScreen
      groupId={activeGroupId}
      socketUrl={SOCKET_URL}
      pttChannelId={pttChannelId ?? undefined}
    />
  );
}

export default withErrorBoundary(MapTab);

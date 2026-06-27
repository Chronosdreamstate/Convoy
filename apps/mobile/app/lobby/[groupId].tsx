import { useLocalSearchParams } from 'expo-router';
import ConvoyLobbyScreen from '../../src/screens/ConvoyLobbyScreen';

export default function LobbyRoute() {
  const { groupId, name } = useLocalSearchParams<{ groupId: string; name: string }>();
  return (
    <ConvoyLobbyScreen
      groupId={groupId ?? ''}
      groupName={name ?? ''}
    />
  );
}

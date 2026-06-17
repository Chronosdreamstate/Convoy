import ConvoyScreen from '../../src/screens/ConvoyScreen';
import { useAuthStore } from '../../src/stores/authStore';
import { View, Text } from 'react-native';

const SOCKET_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function ConvoyTab() {
  const { user } = useAuthStore();
  if (!user) return <View style={{ flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: '#64748b' }}>Sign in to join a convoy.</Text></View>;
  return <ConvoyScreen userId={user.id} socketUrl={SOCKET_URL} />;
}

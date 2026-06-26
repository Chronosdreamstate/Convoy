import ConvoyScreen from '../../src/screens/ConvoyScreen';
import { useAuthStore } from '../../src/stores/authStore';
import { useGroupStore } from '../../src/stores/groupStore';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import ErrorBoundary from '../../src/components/ErrorBoundary';

export default function ConvoyTab() {
  const { user } = useAuthStore();
  const router = useRouter();
  const activeGroupId = useGroupStore((s) => s.activeGroupId);

  if (!user) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Sign in to join a convoy.</Text>
      </View>
    );
  }

  return (
    <ErrorBoundary>
      <View style={styles.root}>
        {/* Browse public groups — only useful when not already in a group */}
        {!activeGroupId && (
          <TouchableOpacity
            style={styles.browseBanner}
            onPress={() => router.push('/group-browse')}
            accessibilityRole="button"
            accessibilityLabel="Browse public groups"
          >
            <Text style={styles.browseText}>🔍  Browse public groups</Text>
            <Text style={styles.browseChevron}>›</Text>
          </TouchableOpacity>
        )}
        <ConvoyScreen userId={user.id} />
      </View>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  centered: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  muted: { color: '#888888' },
  browseBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1C1C1C',
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  browseText: { color: '#DC143C', fontSize: 14, fontWeight: '600' },
  browseChevron: { color: '#DC143C', fontSize: 18, fontWeight: '700' },
});

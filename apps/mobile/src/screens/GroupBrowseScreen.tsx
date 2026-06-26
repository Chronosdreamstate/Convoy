import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublicGroup {
  id: string;
  name: string;
  adminDisplayName: string;
  memberCount: number;
  gapThresholdM: number;
  accessType: 'open' | 'invite_only';
  isActive: boolean;
}

type FilterTab = 'All' | 'Nearby' | 'Active';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatGap(metres: number): string {
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

// ---------------------------------------------------------------------------
// GroupCard
// ---------------------------------------------------------------------------

interface GroupCardProps {
  group: PublicGroup;
  onJoin: (id: string) => void;
  joining: boolean;
}

function GroupCard({ group, onJoin, joining }: GroupCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.groupName} numberOfLines={1}>{group.name}</Text>
        <View style={styles.openBadge}>
          <Text style={styles.openBadgeText}>OPEN</Text>
        </View>
      </View>

      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>👥 {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}</Text>
        <Text style={styles.metaDot}>·</Text>
        <Text style={styles.metaText}>👑 {group.adminDisplayName}</Text>
      </View>

      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>📏 {formatGap(group.gapThresholdM)} gap</Text>
        {group.isActive && (
          <>
            <Text style={styles.metaDot}>·</Text>
            <Text style={styles.activeText}>● Live</Text>
          </>
        )}
      </View>

      <TouchableOpacity
        style={[styles.joinButton, joining && styles.joinButtonDisabled]}
        onPress={() => onJoin(group.id)}
        disabled={joining}
        accessibilityRole="button"
        accessibilityLabel={`Join ${group.name}`}
      >
        {joining ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Text style={styles.joinButtonText}>Join Group</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// GroupBrowseScreen
// ---------------------------------------------------------------------------

export default function GroupBrowseScreen() {
  const router = useRouter();
  const [groups, setGroups] = useState<PublicGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterTab>('All');
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const FILTER_TABS: FilterTab[] = ['All', 'Nearby', 'Active'];

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiClient
      .get<{ groups: PublicGroup[] }>('/groups', {
        params: { accessType: 'open', limit: 20 },
      })
      .then((res) => {
        if (!mounted) return;
        setGroups(res.data.groups ?? []);
      })
      .catch(() => {
        if (!mounted) return;
        Alert.alert('Error', 'Could not load public groups. Please try again.');
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  const filtered = groups.filter((g) => {
    const matchesSearch = g.name.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;
    if (activeFilter === 'Active') return g.isActive;
    return true;
  });

  const handleJoin = useCallback(async (groupId: string) => {
    setJoiningId(groupId);
    try {
      await apiClient.post(`/groups/${groupId}/join`);
      router.back();
    } catch {
      Alert.alert('Could not join', 'This group may be full or no longer available.');
    } finally {
      setJoiningId(null);
    }
  }, [router]);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button">
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Browse Groups</Text>
        <View style={styles.backButton} />
      </View>

      {/* Search bar */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search groups..."
            placeholderTextColor="#555555"
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.clearIcon}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={styles.filterContent}
      >
        {FILTER_TABS.map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.filterPill, activeFilter === tab && styles.filterPillActive]}
            onPress={() => setActiveFilter(tab)}
            accessibilityRole="button"
            accessibilityState={{ selected: activeFilter === tab }}
          >
            <Text style={[styles.filterPillText, activeFilter === tab && styles.filterPillTextActive]}>
              {tab}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Content */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#DC143C" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <GroupCard
              group={item}
              onJoin={handleJoin}
              joining={joiningId === item.id}
            />
          )}
          contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>🔍</Text>
              <Text style={styles.emptyTitle}>No public groups found</Text>
              <Text style={styles.emptySubtitle}>
                {search.length > 0
                  ? 'Try a different search term'
                  : 'Be the first to create a public group'}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backButton: {
    width: 60,
  },
  backText: {
    color: '#DC143C',
    fontSize: 17,
    fontWeight: '600',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  searchRow: {
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    padding: 0,
  },
  clearIcon: {
    color: '#555555',
    fontSize: 14,
    paddingLeft: 8,
  },
  filterRow: {
    flexGrow: 0,
    marginBottom: 12,
  },
  filterContent: {
    paddingHorizontal: 16,
    gap: 8,
    flexDirection: 'row',
  },
  filterPill: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  filterPillActive: {
    backgroundColor: '#DC143C',
    borderColor: '#DC143C',
  },
  filterPillText: {
    color: '#888888',
    fontSize: 13,
    fontWeight: '600',
  },
  filterPillTextActive: {
    color: '#FFFFFF',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 12,
  },
  emptyContainer: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingTop: 80,
  },
  emptyEmoji: {
    fontSize: 52,
    marginBottom: 16,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtitle: {
    color: '#888888',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  // Card
  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  groupName: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  openBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    borderWidth: 1,
    borderColor: '#22C55E',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  openBadgeText: {
    color: '#22C55E',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  metaText: {
    color: '#888888',
    fontSize: 13,
  },
  metaDot: {
    color: '#444444',
    fontSize: 13,
    marginHorizontal: 6,
  },
  activeText: {
    color: '#22C55E',
    fontSize: 13,
    fontWeight: '600',
  },
  joinButton: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 44,
  },
  joinButtonDisabled: {
    opacity: 0.6,
  },
  joinButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});

/**
 * Destination search component — floating search bar that queries the
 * API Mapbox geocoding proxy at GET /api/v1/places/search?q=<query>.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiClient } from '../services/apiClient';
import { useRecentDestinationsStore, RecentDestination } from '../stores/recentDestinationsStore';

export interface SearchResult {
  id: string;
  name: string;
  address: string;
  category: string | null;
  lat: number;
  lng: number;
}

interface ApiPlace {
  id: string;
  name: string;
  address?: string;
  place_name?: string;
  category?: string | null;
  lat: number;
  lng: number;
}

interface Props {
  isOnline: boolean;
  onSelect: (result: SearchResult) => void;
  placeholder?: string;
  /** When true, free-text input is suppressed per Req 32.1 */
  isInMotion?: boolean;
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <View key={i} style={skeletonStyles.row}>
          <View style={skeletonStyles.circle} />
          <View style={skeletonStyles.lines}>
            <View style={[skeletonStyles.bar, skeletonStyles.namebar]} />
            <View style={[skeletonStyles.bar, skeletonStyles.addrbar]} />
          </View>
        </View>
      ))}
    </>
  );
}

const skeletonStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 60,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2A2A2A',
  },
  circle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#2A2A2A',
    marginRight: 10,
  },
  lines: { flex: 1 },
  bar: {
    borderRadius: 4,
    backgroundColor: '#2A2A2A',
    height: 10,
  },
  namebar: { width: '50%', marginBottom: 8 },
  addrbar: { width: '75%' },
});

export default function DestinationSearch({
  isOnline,
  onSelect,
  placeholder = 'Search destination…',
  isInMotion = false,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { destinations: recentDestinations, addDestination } = useRecentDestinationsStore();

  const runSearch = useCallback(
    async (q: string) => {
      if (!isOnline || isInMotion) { setResults([]); setError(null); return; }
      if (q.trim().length < 3) { setResults([]); return; }

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setError(null);
      try {
        const res = await apiClient.get<ApiPlace[]>('/api/v1/places/search', {
          params: { q: q.trim() },
          signal: abortRef.current.signal,
        });
        const places = Array.isArray(res.data) ? res.data : [];
        setResults(
          places.slice(0, 10).map((p) => ({
            id: p.id,
            name: p.name,
            address: p.address ?? p.place_name ?? '',
            category: p.category ?? null,
            lat: p.lat,
            lng: p.lng,
          })),
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'CanceledError') return;
        setError('Search failed. Tap to retry.');
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [isOnline, isInMotion],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runSearch(query); }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [query, runSearch]);

  const handleSelect = useCallback(
    (item: SearchResult) => {
      setQuery(item.name);
      setResults([]);
      setFocused(false);
      addDestination({ id: item.id, name: item.name, address: item.address, lat: item.lat, lng: item.lng });
      onSelect(item);
    },
    [onSelect, addDestination],
  );

  const handleRecentSelect = useCallback(
    (item: RecentDestination) => {
      setFocused(false);
      onSelect({ id: item.id, name: item.name, address: item.address, category: null, lat: item.lat, lng: item.lng });
    },
    [onSelect],
  );

  const showRecentChips = focused && !isInMotion && query.length === 0 && recentDestinations.length > 0;
  const showList = focused && (
    results.length > 0 ||
    loading ||
    !!error ||
    (query.length >= 3 && isOnline) ||
    isInMotion ||
    showRecentChips
  );

  return (
    <View style={styles.wrapper}>
      {/* Input row */}
      <View style={[styles.card, focused && styles.cardFocused]}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={
            isInMotion
              ? 'Park to type a destination'
              : isOnline
              ? placeholder
              : 'Search unavailable offline'
          }
          placeholderTextColor="#555555"
          editable={isOnline && !isInMotion}
          returnKeyType="search"
          accessibilityLabel="Destination search"
        />
        {loading && <ActivityIndicator style={styles.spinner} size="small" color="#DC143C" />}
        {!loading && query.length > 0 && (
          <TouchableOpacity
            onPress={() => { setQuery(''); setResults([]); }}
            style={styles.clearButton}
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.clearIcon}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {showList && (
        <View style={styles.dropdown}>
          {/* Recent destinations chips (idle, query empty) */}
          {showRecentChips && (
            <View style={styles.recentSection}>
              <Text style={styles.recentLabel}>Recent</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipsRow}
                keyboardShouldPersistTaps="handled"
              >
                {recentDestinations.slice(0, 5).map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.chip}
                    onPress={() => handleRecentSelect(item)}
                    accessibilityLabel={`Navigate to recent: ${item.name}`}
                    accessibilityRole="button"
                  >
                    <Text style={styles.chipIcon}>🕐</Text>
                    <Text style={styles.chipText} numberOfLines={1}>{item.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Error / retry */}
          {error && (
            <TouchableOpacity
              onPress={() => void runSearch(query)}
              style={styles.errorRow}
              accessibilityRole="button"
              accessibilityLabel="Retry search"
            >
              <Text style={styles.errorText}>{error}</Text>
            </TouchableOpacity>
          )}

          {/* Offline banner */}
          {!isOnline && (
            <View style={styles.offlineBanner}>
              <Text style={styles.offlineText}>Search is unavailable while offline</Text>
            </View>
          )}

          {/* Motion banner + recent destinations (Req 32.2) */}
          {isInMotion && (
            <View>
              <View style={styles.motionBanner}>
                <Text style={styles.motionText}>Recent destinations — tap to navigate</Text>
              </View>
              {recentDestinations.length > 0 ? (
                recentDestinations.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.result}
                    onPress={() => handleRecentSelect(item)}
                    accessibilityLabel={`Navigate to recent destination: ${item.name}`}
                    accessibilityRole="button"
                  >
                    <Text style={styles.resultIcon}>🕐</Text>
                    <View style={styles.resultBody}>
                      <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.resultAddress} numberOfLines={1}>{item.address}</Text>
                    </View>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.noResults}>No recent destinations yet</Text>
              )}
            </View>
          )}

          {/* Skeleton loading rows */}
          {!isInMotion && loading && <SkeletonRows />}

          {/* Search results */}
          {!isInMotion && !loading && results.length > 0 && (
            <FlatList
              data={results}
              keyExtractor={(r) => r.id}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.result}
                  onPress={() => handleSelect(item)}
                  accessibilityLabel={`Select destination: ${item.name}`}
                  accessibilityRole="button"
                >
                  <Text style={styles.resultIcon}>📍</Text>
                  <View style={styles.resultBody}>
                    <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.resultAddress} numberOfLines={1}>{item.address}</Text>
                    {item.category && (
                      <Text style={styles.resultCategory}>{item.category}</Text>
                    )}
                  </View>
                </TouchableOpacity>
              )}
            />
          )}

          {/* Empty state */}
          {!isInMotion && !loading && !error && isOnline && results.length === 0 && query.length >= 3 && (
            <Text style={styles.noResults}>No results for "{query}"</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {},
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 48,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  cardFocused: {
    borderColor: '#DC143C',
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  input: {
    flex: 1,
    height: 48,
    fontSize: 15,
    color: '#F0F0F0',
  },
  spinner: { marginLeft: 8 },
  clearButton: {
    marginLeft: 8,
    padding: 4,
  },
  clearIcon: {
    fontSize: 14,
    color: '#888888',
    fontWeight: '600',
  },

  dropdown: {
    marginTop: 4,
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },

  recentSection: {
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2A2A2A',
  },
  recentLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#555555',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  chipsRow: {
    paddingHorizontal: 10,
    flexDirection: 'row',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#242424',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    maxWidth: 160,
  },
  chipIcon: { fontSize: 12, marginRight: 4 },
  chipText: {
    fontSize: 13,
    color: '#F0F0F0',
    fontWeight: '500',
  },

  errorRow: { padding: 12, backgroundColor: 'rgba(220,20,60,0.10)' },
  errorText: { color: '#DC143C', fontSize: 13 },

  offlineBanner: { padding: 12, backgroundColor: '#2A2A2A' },
  offlineText: { color: '#888888', fontSize: 13, textAlign: 'center' },
  motionBanner: { padding: 10, paddingBottom: 4, backgroundColor: '#1A1505' },
  motionText: { color: '#B8860B', fontSize: 12, fontWeight: '600', textAlign: 'center' },

  list: { maxHeight: 320 },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2A2A2A',
  },
  resultIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  resultBody: { flex: 1 },
  resultName: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  resultAddress: { fontSize: 13, color: '#888888', marginTop: 2 },
  resultCategory: {
    fontSize: 11,
    color: '#DC143C',
    marginTop: 2,
    textTransform: 'capitalize',
  },
  noResults: { padding: 16, color: '#888888', textAlign: 'center', fontSize: 13 },
});

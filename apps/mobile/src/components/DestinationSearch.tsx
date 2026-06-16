/**
 * Destination search component — floating search bar that queries the
 * API Mapbox geocoding proxy at GET /api/v1/places/search?q=<query>.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiClient } from '../services/apiClient';

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
}

export default function DestinationSearch({
  isOnline,
  onSelect,
  placeholder = 'Search destination…',
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (q: string) => {
      if (!isOnline) { setResults([]); setError(null); return; }
      if (q.trim().length < 3) { setResults([]); return; }

      // Cancel any in-flight request
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
        if (err instanceof Error && err.name === 'CanceledError') return; // aborted — ignore
        setError('Search failed. Tap to retry.');
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [isOnline],
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
      onSelect(item);
    },
    [onSelect],
  );

  const showList = focused && (results.length > 0 || loading || !!error || (query.length >= 3 && isOnline));

  return (
    <View style={styles.wrapper}>
      {/* Input row */}
      <View style={styles.card}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={isOnline ? placeholder : 'Search unavailable offline'}
          placeholderTextColor="#9ca3af"
          editable={isOnline}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="Destination search"
        />
        {loading && <ActivityIndicator style={styles.spinner} size="small" color="#3b82f6" />}
      </View>

      {/* Dropdown results panel */}
      {showList && (
        <View style={styles.dropdown}>
          {/* Error / retry */}
          {error && (
            <TouchableOpacity
              onPress={() => void runSearch(query)}
              style={styles.errorRow}
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

          {/* Results */}
          {results.length > 0 && (
            <FlatList
              data={results}
              keyExtractor={(r) => r.id}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.result}
                  onPress={() => handleSelect(item)}
                  accessibilityLabel={`Select ${item.name}`}
                >
                  <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.resultAddress} numberOfLines={1}>{item.address}</Text>
                  {item.category && (
                    <Text style={styles.resultCategory}>{item.category}</Text>
                  )}
                </TouchableOpacity>
              )}
            />
          )}

          {/* No results */}
          {!loading && !error && isOnline && results.length === 0 && query.length >= 3 && (
            <Text style={styles.noResults}>No results found</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    // Positioned by the parent (MapScreen floats this absolutely)
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 48,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  input: {
    flex: 1,
    height: 48,
    fontSize: 15,
    color: '#111827',
  },
  spinner: { marginLeft: 8 },

  dropdown: {
    marginTop: 4,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },

  errorRow: { padding: 12, backgroundColor: '#fef2f2' },
  errorText: { color: '#dc2626', fontSize: 13 },

  offlineBanner: { padding: 12, backgroundColor: '#f3f4f6' },
  offlineText: { color: '#6b7280', fontSize: 13, textAlign: 'center' },

  list: { maxHeight: 320 },
  result: {
    padding: 12,
    minHeight: 44,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f3f4f6',
  },
  resultName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  resultAddress: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  resultCategory: {
    fontSize: 11,
    color: '#3b82f6',
    marginTop: 2,
    textTransform: 'capitalize',
  },
  noResults: { padding: 16, color: '#6b7280', textAlign: 'center', fontSize: 13 },
});

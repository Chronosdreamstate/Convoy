/**
 * Destination search component (Req 18.1–18.9)
 * Queries Mapbox Geocoding after 3 chars; shows 5–10 results within 2 s.
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
import { SearchService, SearchResult } from '../services/SearchService';

interface Props {
  searchService: SearchService;
  isOnline: boolean;
  onSelect: (result: SearchResult) => void;
  placeholder?: string;
}

export default function DestinationSearch({
  searchService,
  isOnline,
  onSelect,
  placeholder = 'Search destination…',
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    async (q: string) => {
      if (!isOnline) { setResults([]); setError(null); return; }
      if (q.trim().length < 3) { setResults([]); return; }
      setLoading(true);
      setError(null);
      try {
        const data = await searchService.search(q);
        setResults(data);
      } catch {
        setError('Search failed. Tap to retry.');
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [searchService, isOnline],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runSearch(query); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  return (
    <View style={styles.container}>
      {/* Input (Req 18.1) */}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder={isOnline ? placeholder : 'Search unavailable offline'}
          placeholderTextColor="#9ca3af"
          editable={isOnline}          // Disabled while offline (Req 18.8, Property 30)
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {loading && <ActivityIndicator style={styles.spinner} size="small" color="#3b82f6" />}
      </View>

      {/* Error / retry (Req 18.9) */}
      {error && (
        <TouchableOpacity onPress={() => void runSearch(query)} style={styles.errorRow}>
          <Text style={styles.errorText}>{error}</Text>
        </TouchableOpacity>
      )}

      {/* Offline banner (Req 18.8) */}
      {!isOnline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>Search is unavailable while offline</Text>
        </View>
      )}

      {/* Results list — 5–10 items (Req 18.5, Property 29) */}
      {results.length > 0 && (
        <FlatList
          data={results}
          keyExtractor={(r) => r.id}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.result} onPress={() => onSelect(item)}>
              <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.resultAddress} numberOfLines={1}>{item.address}</Text>
              {item.category && (
                <Text style={styles.resultCategory}>{item.category}</Text>
              )}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            query.length >= 3 && !loading ? (
              <Text style={styles.noResults}>No results found</Text>
            ) : null
          }
        />
      )}

      {/* No results (Req 18.7) */}
      {!loading && results.length === 0 && query.length >= 3 && isOnline && !error && (
        <Text style={styles.noResults}>No results found</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#ffffff', borderRadius: 12, overflow: 'hidden' },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  input: {
    flex: 1, height: 48, fontSize: 15, color: '#111827',
  },
  spinner: { marginLeft: 8 },

  errorRow: { padding: 12, backgroundColor: '#fef2f2' },
  errorText: { color: '#dc2626', fontSize: 13 },

  offlineBanner: { padding: 12, backgroundColor: '#f3f4f6' },
  offlineText: { color: '#6b7280', fontSize: 13, textAlign: 'center' },

  list: { maxHeight: 320 },
  result: {
    padding: 12, borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  resultName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  resultAddress: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  resultCategory: {
    fontSize: 11, color: '#3b82f6', marginTop: 2,
    textTransform: 'capitalize',
  },
  noResults: { padding: 16, color: '#6b7280', textAlign: 'center', fontSize: 13 },
});

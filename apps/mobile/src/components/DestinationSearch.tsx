/**
 * Destination search component — floating search bar that queries the
 * API Mapbox geocoding proxy at GET /api/v1/places/search?q=<query>.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { useRecentDestinationsStore, RecentDestination } from '../stores/recentDestinationsStore';
import { ThemeColors, useTheme, withAlpha } from '../theme';

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
  /**
   * Current device position, used to bias search results toward nearby places
   * (Req 18.2/18.3). Without this the backend queries Nominatim with no viewbox
   * at all, so a query like "coffee" returns unrelated administrative regions
   * named "Coffee County" instead of nearby coffee shops.
   */
  userLat?: number | null;
  userLng?: number | null;
}

function SkeletonRows({ colors }: { colors: ThemeColors }) {
  const styles = useMemo(() => makeSkeletonStyles(colors), [colors]);
  return (
    <>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.row}>
          <View style={styles.circle} />
          <View style={styles.lines}>
            <View style={[styles.bar, styles.namebar]} />
            <View style={[styles.bar, styles.addrbar]} />
          </View>
        </View>
      ))}
    </>
  );
}

function makeSkeletonStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 60,
      paddingHorizontal: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    circle: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.border,
      marginRight: 10,
    },
    lines: { flex: 1 },
    bar: {
      borderRadius: 4,
      backgroundColor: colors.border,
      height: 10,
    },
    namebar: { width: '50%', marginBottom: 8 },
    addrbar: { width: '75%' },
  });
}

export default function DestinationSearch({
  isOnline,
  onSelect,
  placeholder = 'Search destination…',
  isInMotion = false,
  userLat = null,
  userLng = null,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const userLatRef = useRef(userLat);
  const userLngRef = useRef(userLng);
  userLatRef.current = userLat;
  userLngRef.current = userLng;

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
        // Bias results toward the user's current position — without this the
        // backend has no viewbox to rank/scope results by, so common queries
        // return distant, irrelevant matches (Req 18.2/18.3).
        const params: { q: string; lat?: number; lng?: number } = { q: q.trim() };
        if (userLatRef.current != null && userLngRef.current != null) {
          params.lat = userLatRef.current;
          params.lng = userLngRef.current;
        }
        const res = await apiClient.get<ApiPlace[]>('/api/v1/places/search', {
          params,
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
        <Ionicons name="search" size={16} color={colors.textMuted} style={styles.searchIcon} />
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
          placeholderTextColor={colors.textSubtle}
          editable={isOnline && !isInMotion}
          returnKeyType="search"
          accessibilityLabel="Destination search"
        />
        {loading && <ActivityIndicator style={styles.spinner} size="small" color={colors.accent} />}
        {!loading && query.length > 0 && (
          <TouchableOpacity
            onPress={() => { setQuery(''); setResults([]); }}
            style={styles.clearButton}
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close" size={14} color={colors.textMuted} />
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
                    <Ionicons name="time-outline" size={12} color={colors.textMuted} style={styles.chipIcon} />
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
                // Req 33: cap the scrollable recent-destinations list to ~4 rows
                // while in motion — recentDestinations can hold up to MAX_RECENT (5).
                recentDestinations.slice(0, 4).map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.result}
                    onPress={() => handleRecentSelect(item)}
                    accessibilityLabel={`Navigate to recent destination: ${item.name}`}
                    accessibilityRole="button"
                  >
                    <Ionicons name="time-outline" size={18} color={colors.textMuted} style={styles.resultIcon} />
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
          {!isInMotion && loading && <SkeletonRows colors={colors} />}

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
                  <Ionicons name="location" size={18} color={colors.textMuted} style={styles.resultIcon} />
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

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrapper: {},
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 12,
      paddingHorizontal: 12,
      height: 48,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOpacity: 0.4,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 5,
    },
    cardFocused: {
      borderColor: colors.accent,
    },
    searchIcon: { marginRight: 8 },
    input: {
      flex: 1,
      height: 48,
      fontSize: 15,
      color: colors.text,
    },
    spinner: { marginLeft: 8 },
    clearButton: {
      marginLeft: 8,
      padding: 4,
    },

    dropdown: {
      marginTop: 4,
      backgroundColor: colors.card,
      borderRadius: 12,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
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
      borderBottomColor: colors.border,
    },
    recentLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textSubtle,
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
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginRight: 8,
      maxWidth: 160,
    },
    chipIcon: { marginRight: 4 },
    chipText: {
      fontSize: 13,
      color: colors.text,
      fontWeight: '500',
    },

    errorRow: { padding: 12, backgroundColor: withAlpha(colors.accent, 0.10) },
    errorText: { color: colors.accent, fontSize: 13 },

    offlineBanner: { padding: 12, backgroundColor: colors.border },
    offlineText: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
    motionBanner: { padding: 10, paddingBottom: 4, backgroundColor: withAlpha(colors.warning, 0.15) },
    motionText: { color: colors.warning, fontSize: 12, fontWeight: '600', textAlign: 'center' },

    list: { maxHeight: 320 },
    result: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      height: 60,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    resultIcon: {
      marginRight: 10,
    },
    resultBody: { flex: 1 },
    resultName: { fontSize: 16, fontWeight: '700', color: colors.text },
    resultAddress: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
    resultCategory: {
      fontSize: 11,
      color: colors.accent,
      marginTop: 2,
      textTransform: 'capitalize',
    },
    noResults: { padding: 16, color: colors.textMuted, textAlign: 'center', fontSize: 13 },
  });
}

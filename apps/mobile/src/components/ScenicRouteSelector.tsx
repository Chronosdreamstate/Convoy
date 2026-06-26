import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

export interface RouteOption {
  index: number;
  distanceText: string;
  durationText: string;
  scenicScore?: number;
  speedLimitKph?: number | null;
}

interface Props {
  routes: RouteOption[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onConfirm: () => void;
  onDismiss: () => void;
}

function getBadge(route: RouteOption, routes: RouteOption[]): { label: string; color: string } | null {
  const fastestDuration = Math.min(...routes.map((r) => parseDurationMinutes(r.durationText)));
  const thisDuration = parseDurationMinutes(route.durationText);
  const maxScenic = Math.max(...routes.map((r) => r.scenicScore ?? 0));

  if (thisDuration === fastestDuration && routes.length > 1) {
    return { label: '⚡ Fastest', color: '#F59E0B' };
  }
  if ((route.scenicScore ?? 0) === maxScenic && maxScenic > 70 && routes.length > 1) {
    return { label: '🌲 Most Scenic', color: '#22C55E' };
  }
  return null;
}

function parseDurationMinutes(text: string): number {
  const hMatch = text.match(/(\d+)\s*h/);
  const mMatch = text.match(/(\d+)\s*m/);
  return (hMatch ? parseInt(hMatch[1]) * 60 : 0) + (mMatch ? parseInt(mMatch[1]) : 0);
}

function ScenicRouteSelector({ routes, selectedIndex, onSelect, onConfirm, onDismiss }: Props) {
  const displayRoutes = routes.slice(0, 3);

  return (
    <View style={styles.sheet}>
      {/* Drag handle */}
      <View style={styles.handle} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Choose Your Route</Text>
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Close route selector"
        >
          <Text style={styles.closeIcon}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Route options */}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {displayRoutes.map((route) => {
          const selected = route.index === selectedIndex;
          const badge = getBadge(route, displayRoutes);
          const isScenic = (route.scenicScore ?? 0) > 70;

          return (
            <TouchableOpacity
              key={route.index}
              style={[styles.routeCard, selected && styles.routeCardSelected]}
              onPress={() => onSelect(route.index)}
              accessibilityRole="button"
              accessibilityLabel={`Route ${route.index + 1}: ${route.distanceText}, ${route.durationText}`}
              accessibilityState={{ selected }}
            >
              {/* Selected left strip */}
              {selected && <View style={styles.selectedStrip} />}

              <View style={styles.routeContent}>
                <View style={styles.routeMain}>
                  <Text style={styles.routeIndex}>Route {route.index + 1}</Text>
                  <View style={styles.routeStats}>
                    <Text style={styles.routeDuration}>{route.durationText}</Text>
                    <Text style={styles.routeDistance}> · {route.distanceText}</Text>
                  </View>

                  {/* Sub-info row */}
                  <View style={styles.routeMeta}>
                    {route.speedLimitKph != null && (
                      <View style={styles.metaChip}>
                        <Text style={styles.metaChipText}>⚡ {route.speedLimitKph} km/h zone</Text>
                      </View>
                    )}
                    {isScenic && (
                      <View style={[styles.metaChip, styles.scenicChip]}>
                        <Text style={[styles.metaChipText, styles.scenicChipText]}>
                          🌲 Scenic{route.scenicScore ? ` (${route.scenicScore}/100)` : ''}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>

                {/* Badge */}
                {badge && (
                  <View style={[styles.badge, { borderColor: badge.color }]}>
                    <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Confirm */}
      <TouchableOpacity
        style={[styles.confirmBtn, selectedIndex < 0 && styles.confirmBtnDisabled]}
        onPress={onConfirm}
        disabled={selectedIndex < 0}
        accessibilityRole="button"
        accessibilityLabel="Use selected route"
        accessibilityState={{ disabled: selectedIndex < 0 }}
      >
        <Text style={styles.confirmBtnText}>Use This Route</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderColor: '#2A2A2A',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#3A3A3A',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  closeIcon: {
    fontSize: 18,
    color: '#888888',
    fontWeight: '600',
  },
  list: {
    maxHeight: 300,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  routeCard: {
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  routeCardSelected: {
    backgroundColor: '#161616',
    borderColor: '#3A3A3A',
  },
  selectedStrip: {
    width: 4,
    backgroundColor: '#DC143C',
  },
  routeContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  routeMain: {
    flex: 1,
  },
  routeIndex: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888888',
    letterSpacing: 1,
    marginBottom: 4,
  },
  routeStats: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  routeDuration: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  routeDistance: {
    fontSize: 14,
    color: '#888888',
    fontWeight: '500',
  },
  routeMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  metaChip: {
    backgroundColor: '#1C1C1C',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  metaChipText: {
    fontSize: 11,
    color: '#888888',
    fontWeight: '600',
  },
  scenicChip: {
    borderColor: '#22C55E44',
    backgroundColor: '#22C55E11',
  },
  scenicChipText: {
    color: '#22C55E',
  },
  badge: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginLeft: 8,
    alignSelf: 'center',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  confirmBtn: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});

export default React.memo(ScenicRouteSelector);

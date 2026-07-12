/**
 * CongestionRoutePolyline — the active route line with four-tier traffic
 * color coding (Req 6.2): green / yellow / red / dark-red per congestion tier.
 *
 * Contiguous same-tier segments are grouped into ONE Polyline per run instead
 * of one per segment — a typical route has hundreds of geometry segments but
 * only a handful of tier transitions, and MapScreen has a re-render-storm
 * history, so the native view count must stay proportional to tier changes,
 * not route length. When a route carries no congestion data at all (older
 * server, Mapbox omitted the annotation), a single default-colored Polyline
 * renders — identical to the pre-congestion behavior.
 */

import React, { useMemo } from 'react';
import { Polyline } from 'react-native-maps';
import type { CongestionTier } from '../../services/RouteService';

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface TierRun {
  tier: CongestionTier | null;
  coordinates: RoutePoint[];
}

// Fixed traffic-severity colors on purpose (not theme tokens): the route line
// floats over map imagery, not the app's light/dark surface, and green/yellow/
// red/dark-red are the spec's mandated coding (Req 6.2) — the same rationale
// as MemberMarkerView's hardcoded white ring in MapScreen.
export const CONGESTION_TIER_COLORS: Record<CongestionTier, string> = {
  green: '#22C55E',
  yellow: '#FACC15',
  red: '#EF4444',
  'dark-red': '#7F1D1D',
};

/**
 * Group per-segment tiers into contiguous same-tier runs. `tiers[i]` covers
 * coordinates[i]→coordinates[i+1]; a run over segments a..b therefore spans
 * coordinates[a..b+1], so adjacent runs share their boundary point and the
 * rendered line stays visually continuous. Missing tier entries (short/absent
 * congestion data) are treated as null. Pure function — exported for tests.
 */
export function groupContiguousTierRuns(
  coordinates: RoutePoint[],
  tiers: (CongestionTier | null)[],
): TierRun[] {
  const segmentCount = coordinates.length - 1;
  if (segmentCount < 1) return [];
  const runs: TierRun[] = [];
  let runStart = 0;
  let runTier = tiers[0] ?? null;
  for (let i = 1; i < segmentCount; i++) {
    const tier = tiers[i] ?? null;
    if (tier !== runTier) {
      runs.push({ tier: runTier, coordinates: coordinates.slice(runStart, i + 1) });
      runStart = i;
      runTier = tier;
    }
  }
  runs.push({ tier: runTier, coordinates: coordinates.slice(runStart, segmentCount + 1) });
  return runs;
}

interface Props {
  coordinates: RoutePoint[];
  /** Per-segment tiers aligned to `coordinates` (entry i covers i→i+1). */
  tiers: (CongestionTier | null)[];
  /** Route color for untinted (null-tier) segments and tier-less routes. */
  defaultColor: string;
}

function CongestionRoutePolyline({ coordinates, tiers, defaultColor }: Props) {
  const hasTierData = useMemo(() => tiers.some((t) => t !== null), [tiers]);
  const runs = useMemo(
    () => (hasTierData ? groupContiguousTierRuns(coordinates, tiers) : []),
    [hasTierData, coordinates, tiers],
  );

  if (coordinates.length < 2) return null;

  // No congestion data anywhere on the route — render the classic single line.
  if (!hasTierData) {
    return (
      <Polyline
        coordinates={coordinates}
        strokeColor={defaultColor}
        strokeWidth={4}
        lineDashPattern={[1]}
      />
    );
  }

  return (
    <>
      {runs.map((run, idx) => (
        <Polyline
          // Index keys are safe here: runs are only ever replaced wholesale
          // when the route (or its congestion data) changes, never reordered.
          key={idx}
          coordinates={run.coordinates}
          strokeColor={run.tier ? CONGESTION_TIER_COLORS[run.tier] : defaultColor}
          strokeWidth={4}
          lineDashPattern={[1]}
        />
      ))}
    </>
  );
}

// React.memo — MapScreen re-renders on every GPS tick, but coordinates/tiers
// only change identity when the route itself changes.
const MemoCongestionRoutePolyline = React.memo(CongestionRoutePolyline);
MemoCongestionRoutePolyline.displayName = 'CongestionRoutePolyline';
export default MemoCongestionRoutePolyline;

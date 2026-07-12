/**
 * CongestionRoutePolyline tests (Req 6.2):
 *  - groupContiguousTierRuns — contiguous same-tier segments merge into one
 *    run, adjacent runs share their boundary coordinate, and the run count is
 *    proportional to tier TRANSITIONS (the performance contract), not length.
 *  - Rendering — one Polyline per run with the spec's four-tier colors, and a
 *    single default-colored Polyline when the route has no congestion data.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import type { CongestionTier } from '../../services/RouteService';

// react-native-maps registers native view components at import time, which the
// jest environment doesn't provide — stub it before importing the component.
jest.mock('react-native-maps', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const mockComponent = (name: string) =>
    (props: { children?: unknown }) => React.createElement(name, props as never, props.children as never);
  return {
    __esModule: true,
    default: mockComponent('MapView'),
    Marker: mockComponent('Marker'),
    Callout: mockComponent('Callout'),
    Polyline: mockComponent('Polyline'),
    PROVIDER_DEFAULT: 'default',
  };
});

import CongestionRoutePolyline, {
  CONGESTION_TIER_COLORS,
  groupContiguousTierRuns,
  RoutePoint,
} from './CongestionRoutePolyline';

/** n points spaced along a line — enough shape for grouping/rendering tests. */
function points(n: number): RoutePoint[] {
  return Array.from({ length: n }, (_, i) => ({ latitude: 37.7, longitude: -122.4 + i * 0.01 }));
}

/** All rendered Polyline elements' props, in order. */
function renderedPolylines(element: React.ReactElement) {
  const json = render(element).toJSON();
  const nodes = json == null ? [] : Array.isArray(json) ? json : [json];
  return nodes
    .filter((n) => n.type === 'Polyline')
    .map((n) => n.props as { coordinates: RoutePoint[]; strokeColor: string });
}

describe('groupContiguousTierRuns', () => {
  it('merges contiguous same-tier segments into single runs sharing boundary points', () => {
    const coords = points(6); // 5 segments
    const tiers: (CongestionTier | null)[] = ['green', 'green', 'red', 'red', 'green'];
    const runs = groupContiguousTierRuns(coords, tiers);
    expect(runs.map((r) => r.tier)).toEqual(['green', 'red', 'green']);
    // Runs over segments 0–1 / 2–3 / 4 span coords [0..2] / [2..4] / [4..5].
    expect(runs[0].coordinates).toEqual(coords.slice(0, 3));
    expect(runs[1].coordinates).toEqual(coords.slice(2, 5));
    expect(runs[2].coordinates).toEqual(coords.slice(4, 6));
  });

  it('produces one run per tier TRANSITION, not per segment', () => {
    const coords = points(101); // 100 segments, uniform tier
    const runs = groupContiguousTierRuns(coords, new Array(100).fill('yellow'));
    expect(runs).toHaveLength(1);
    expect(runs[0].coordinates).toHaveLength(101);
  });

  it('treats missing tier entries as null (untinted) segments', () => {
    const coords = points(4); // 3 segments, only 1 tier supplied
    const runs = groupContiguousTierRuns(coords, ['dark-red']);
    expect(runs.map((r) => r.tier)).toEqual(['dark-red', null]);
    expect(runs[0].coordinates).toEqual(coords.slice(0, 2));
    expect(runs[1].coordinates).toEqual(coords.slice(1, 4));
  });

  it('returns no runs for degenerate geometries', () => {
    expect(groupContiguousTierRuns([], [])).toEqual([]);
    expect(groupContiguousTierRuns(points(1), [])).toEqual([]);
  });
});

describe('CongestionRoutePolyline rendering', () => {
  it('renders one Polyline per contiguous tier run, colored by tier', () => {
    const coords = points(5); // 4 segments
    const lines = renderedPolylines(
      <CongestionRoutePolyline
        coordinates={coords}
        tiers={['green', 'yellow', 'yellow', 'dark-red']}
        defaultColor="#DC143C"
      />,
    );
    expect(lines.map((l) => l.strokeColor)).toEqual([
      CONGESTION_TIER_COLORS.green,
      CONGESTION_TIER_COLORS.yellow,
      CONGESTION_TIER_COLORS['dark-red'],
    ]);
    // Adjacent runs share boundary points so the line renders continuously.
    expect(lines[0].coordinates[lines[0].coordinates.length - 1]).toEqual(lines[1].coordinates[0]);
    expect(lines[1].coordinates[lines[1].coordinates.length - 1]).toEqual(lines[2].coordinates[0]);
  });

  it('renders null-tier runs in the default route color', () => {
    const lines = renderedPolylines(
      <CongestionRoutePolyline
        coordinates={points(4)}
        tiers={['red', null, 'red']}
        defaultColor="#DC143C"
      />,
    );
    expect(lines.map((l) => l.strokeColor)).toEqual([
      CONGESTION_TIER_COLORS.red,
      '#DC143C',
      CONGESTION_TIER_COLORS.red,
    ]);
  });

  it('falls back to a single default-colored line when the route has no congestion data', () => {
    const coords = points(4);
    const lines = renderedPolylines(
      <CongestionRoutePolyline coordinates={coords} tiers={[null, null, null]} defaultColor="#DC143C" />,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].strokeColor).toBe('#DC143C');
    expect(lines[0].coordinates).toEqual(coords);

    const emptyTiers = renderedPolylines(
      <CongestionRoutePolyline coordinates={coords} tiers={[]} defaultColor="#DC143C" />,
    );
    expect(emptyTiers).toHaveLength(1);
  });

  it('renders nothing for a degenerate route', () => {
    expect(
      renderedPolylines(
        <CongestionRoutePolyline coordinates={points(1)} tiers={[]} defaultColor="#DC143C" />,
      ),
    ).toHaveLength(0);
  });
});

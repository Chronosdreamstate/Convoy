/**
 * MapDataUnavailableBadge tests (Req 4.4):
 *  - regionHasCachedMapData — the viewed region only counts as covered when it
 *    sits ENTIRELY inside the cached tile bounds; no region / no bounds means
 *    no coverage (nothing prefetched → map data unavailable offline).
 *  - Rendering — the badge announces itself accessibly and mounts under both
 *    reduce-motion settings (the fade-in is skipped, not the badge).
 */

import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import MapDataUnavailableBadge, {
  CachedTileBounds,
  regionHasCachedMapData,
} from './MapDataUnavailableBadge';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('regionHasCachedMapData', () => {
  // Cached corridor: lng -123..-121, lat 37..39 ([[minLng, minLat], [maxLng, maxLat]]).
  const bounds: CachedTileBounds = [[-123, 37], [-121, 39]];
  const region = (latitude: number, longitude: number, delta = 0.5) => ({
    latitude,
    longitude,
    latitudeDelta: delta,
    longitudeDelta: delta,
  });

  it('covers a region fully inside the cached bounds', () => {
    expect(regionHasCachedMapData(region(38, -122), bounds)).toBe(true);
  });

  it('does not cover a region entirely outside the bounds', () => {
    expect(regionHasCachedMapData(region(45, -100), bounds)).toBe(false);
  });

  it('does not cover a region that only partially overlaps the bounds', () => {
    // Center inside, but the viewport's north edge (39.1) leaves the corridor.
    expect(regionHasCachedMapData(region(38.9, -122), bounds)).toBe(false);
  });

  it('treats a viewport exactly at the cached edge as covered', () => {
    // Center 38, delta 2 → spans lat 37..39 and lng -123..-121 precisely.
    expect(regionHasCachedMapData(region(38, -122, 2), bounds)).toBe(true);
  });

  it('reports no coverage without a known region or without cached bounds', () => {
    expect(regionHasCachedMapData(null, bounds)).toBe(false);
    expect(regionHasCachedMapData(region(38, -122), null)).toBe(false);
    expect(regionHasCachedMapData(null, null)).toBe(false);
  });
});

describe('MapDataUnavailableBadge rendering', () => {
  function mockReduceMotion(enabled: boolean) {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(enabled);
    jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockImplementation(() => ({ remove: jest.fn() } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>));
  }

  it('renders the badge with its accessibility announcement', async () => {
    mockReduceMotion(false);
    const screen = render(<MapDataUnavailableBadge />);
    expect(screen.getByTestId('map-data-unavailable-badge')).toBeTruthy();
    expect(screen.getByLabelText('Map data unavailable for this area')).toBeTruthy();
    expect(screen.getByText('Map data unavailable')).toBeTruthy();
  });

  it('still renders when reduce motion is enabled (only the fade is skipped)', async () => {
    mockReduceMotion(true);
    const screen = render(<MapDataUnavailableBadge />);
    await waitFor(() => {
      expect(screen.getByTestId('map-data-unavailable-badge')).toBeTruthy();
    });
    expect(screen.getByText('Map data unavailable')).toBeTruthy();
  });
});

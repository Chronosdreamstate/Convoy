/**
 * FuelSuggestionBanner — fuel stop suggestion flow (Requirements 21.2–21.5):
 *  - "Find Fuel" queries the places API for stations near the caller.
 *  - Accepting a station hands it to onSelectStation, whose contract (Req
 *    21.3) is to add it as a ROUTE WAYPOINT via the route-recalculation flow.
 *  - The accept button is Admin-only; the empty result set shows the
 *    "no stations" message (Req 21.5).
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGet = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: jest.fn(),
  },
}));

import FuelSuggestionBanner from './FuelSuggestionBanner';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATION = {
  id: 'st-1',
  name: 'Shell Kirribilli',
  distanceM: 850,
  lat: -33.84,
  lng: 151.21,
  address: '1 Pacific Hwy, Kirribilli',
};

function renderBanner(overrides: Partial<React.ComponentProps<typeof FuelSuggestionBanner>> = {}) {
  return render(
    <FuelSuggestionBanner
      groupId="g-1"
      myLat={-33.8}
      myLng={151.2}
      isAdmin
      onSelectStation={jest.fn()}
      onDismiss={jest.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FuelSuggestionBanner', () => {
  it('queries the places API for nearby stations on "Find Fuel" (Req 21.2)', async () => {
    mockGet.mockResolvedValue({ data: { stations: [STATION] } });

    const screen = renderBanner();
    fireEvent.press(screen.getByText('Find Fuel'));

    await waitFor(() => {
      expect(screen.getByText('Shell Kirribilli')).toBeTruthy();
    });
    expect(mockGet).toHaveBeenCalledWith('/api/v1/places/fuel?lat=-33.8&lng=151.2');
  });

  it('accepting a station hands the exact station to onSelectStation (Req 21.3)', async () => {
    mockGet.mockResolvedValue({ data: { stations: [STATION] } });
    const onSelectStation = jest.fn();

    const screen = renderBanner({ onSelectStation });
    fireEvent.press(screen.getByText('Find Fuel'));
    await waitFor(() => {
      expect(screen.getByText('Add waypoint')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('Add waypoint'));
    expect(onSelectStation).toHaveBeenCalledWith(STATION);
  });

  it('hides the accept button for non-admin members', async () => {
    mockGet.mockResolvedValue({ data: { stations: [STATION] } });

    const screen = renderBanner({ isAdmin: false });
    fireEvent.press(screen.getByText('Find Fuel'));
    await waitFor(() => {
      expect(screen.getByText('Shell Kirribilli')).toBeTruthy();
    });

    expect(screen.queryByText('Add waypoint')).toBeNull();
  });

  it('shows the no-stations message when the search comes back empty (Req 21.5)', async () => {
    mockGet.mockResolvedValue({ data: { stations: [], message: 'No fuel stations found nearby' } });

    const screen = renderBanner();
    fireEvent.press(screen.getByText('Find Fuel'));

    await waitFor(() => {
      expect(screen.getByText('No fuel stations found in your area.')).toBeTruthy();
    });
    expect(screen.queryByText('Add waypoint')).toBeNull();
  });
});

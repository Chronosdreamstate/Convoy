/**
 * MemberDetailModal — active vehicle display (Requirements 29.4, 29.5, 29.6):
 *  - Opening the sheet fetches the member's active vehicle and renders
 *    year/make/model, colour, and photo.
 *  - A member with no active vehicle (or a failed fetch) shows the
 *    "No vehicle set" fallback.
 *
 * Member ETA to the shared destination (Requirement 8.5):
 *  - Opening the sheet fetches the server-computed (synchronized) ETA and
 *    renders it as a stat pill.
 *  - No shared destination / failed fetch / no active group all omit the
 *    pill instead of fabricating a value.
 */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGet = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

import MemberDetailModal from './MemberDetailModal';
import { useGroupStore } from '../stores/groupStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMBER = {
  userId: 'user-42',
  displayName: 'Dana Driver',
  callsign: 'Red Leader',
  isAdmin: false,
  isOnline: true,
};

const VEHICLE = {
  id: 'veh-1',
  name: 'Daily',
  type: 'car',
  year: 2021,
  make: 'Subaru',
  model: 'WRX',
  color: 'Blue',
  photoUrl: 'http://localhost:3000/api/v1/uploads/abc.jpg',
};

function renderModal() {
  return render(
    <MemberDetailModal
      visible
      member={MEMBER}
      isCurrentUserAdmin={false}
      onClose={jest.fn()}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemberDetailModal vehicle section', () => {
  it("fetches and renders the member's active vehicle: title, colour, and photo", async () => {
    mockGet.mockResolvedValue({ data: { vehicle: VEHICLE } });

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('2021 Subaru WRX')).toBeTruthy();
    });
    expect(mockGet).toHaveBeenCalledWith('/api/v1/vehicles/active/user-42');
    expect(screen.getByText('Blue')).toBeTruthy();
    expect(screen.getByTestId('member-vehicle-swatch')).toBeTruthy();
    const photo = screen.getByTestId('member-vehicle-photo');
    expect(photo.props.source).toEqual({ uri: VEHICLE.photoUrl });
    expect(screen.queryByText('No vehicle set')).toBeNull();
  });

  it('renders without a photo when the vehicle has none', async () => {
    mockGet.mockResolvedValue({ data: { vehicle: { ...VEHICLE, photoUrl: null } } });

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('2021 Subaru WRX')).toBeTruthy();
    });
    expect(screen.queryByTestId('member-vehicle-photo')).toBeNull();
  });

  it('shows "No vehicle set" when the member has no active vehicle (Req 29.6)', async () => {
    mockGet.mockResolvedValue({ data: { vehicle: null } });

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('No vehicle set')).toBeTruthy();
    });
    expect(screen.queryByTestId('member-vehicle-photo')).toBeNull();
    expect(screen.queryByTestId('member-vehicle-swatch')).toBeNull();
  });

  it('degrades to "No vehicle set" when the fetch fails', async () => {
    mockGet.mockRejectedValue(new Error('403 forbidden'));

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('No vehicle set')).toBeTruthy();
    });
  });

  it('renders unrelated member details alongside the vehicle card', async () => {
    mockGet.mockResolvedValue({ data: { vehicle: null } });

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('No vehicle set')).toBeTruthy();
    });
    expect(screen.getByText('Dana Driver')).toBeTruthy();
    expect(screen.getByText('Red Leader')).toBeTruthy();
  });
});

describe('MemberDetailModal ETA pill (Req 8.5)', () => {
  // Route the two fetch-on-open GETs (vehicle + eta) by URL.
  function mockApis(etaSeconds: number | null) {
    mockGet.mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.endsWith('/eta')) {
        return Promise.resolve({ data: { etaSeconds, distanceM: etaSeconds != null ? 1000 : null } });
      }
      return Promise.resolve({ data: { vehicle: null } });
    });
  }

  // act(): the store update re-renders any still-mounted modal from the
  // previous test (RNTL cleanup runs after this afterEach), which would
  // otherwise trip the not-wrapped-in-act warning.
  beforeEach(() => {
    act(() => { useGroupStore.getState().setActiveGroupId('group-7'); });
  });

  afterEach(() => {
    act(() => { useGroupStore.getState().setActiveGroupId(null); });
  });

  /** Flush the second fetch-on-open effect so its setState lands inside act. */
  async function settleEffects() {
    await act(async () => {});
  }

  it('fetches and renders the synchronized ETA to the shared destination', async () => {
    mockApis(300); // 5 minutes out

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByTestId('member-eta-pill')).toBeTruthy();
    });
    await settleEffects();
    expect(screen.getByText('ETA 5 min')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith('/api/v1/groups/group-7/members/user-42/eta');
  });

  it('formats hour-scale ETAs like the route durationText', async () => {
    mockApis(4800); // 80 minutes

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('ETA 1 h 20 min')).toBeTruthy();
    });
    await settleEffects();
  });

  it('omits the pill when there is no shared destination (etaSeconds null)', async () => {
    mockApis(null);

    const screen = renderModal();

    // Settle both fetch-on-open effects before asserting absence.
    await waitFor(() => {
      expect(screen.getByText('No vehicle set')).toBeTruthy();
    });
    await settleEffects();
    expect(screen.queryByTestId('member-eta-pill')).toBeNull();
  });

  it('omits the pill when the ETA fetch fails', async () => {
    mockGet.mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.endsWith('/eta')) {
        return Promise.reject(new Error('500'));
      }
      return Promise.resolve({ data: { vehicle: null } });
    });

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('No vehicle set')).toBeTruthy();
    });
    await settleEffects();
    expect(screen.queryByTestId('member-eta-pill')).toBeNull();
  });

  it('does not request an ETA outside an active group', async () => {
    act(() => { useGroupStore.getState().setActiveGroupId(null); });
    mockApis(300);

    const screen = renderModal();

    await waitFor(() => {
      expect(screen.getByText('No vehicle set')).toBeTruthy();
    });
    await settleEffects();
    expect(screen.queryByTestId('member-eta-pill')).toBeNull();
    expect(mockGet).not.toHaveBeenCalledWith(expect.stringContaining('/eta'));
  });
});

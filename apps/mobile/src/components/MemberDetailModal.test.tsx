/**
 * MemberDetailModal — active vehicle display (Requirements 29.4, 29.5, 29.6):
 *  - Opening the sheet fetches the member's active vehicle and renders
 *    year/make/model, colour, and photo.
 *  - A member with no active vehicle (or a failed fetch) shows the
 *    "No vehicle set" fallback.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

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

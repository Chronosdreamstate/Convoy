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
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
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

// ---------------------------------------------------------------------------
// Friend-state awareness (Req 30.1) — the sheet fetches the relationship on
// open and must not offer "Add Friend" to existing friends or to members with
// a request already pending in either direction.
// ---------------------------------------------------------------------------

describe('MemberDetailModal friend button state', () => {
  function mockRoutes(profile: { friendStatus: string | null; friendRequestDirection?: string | null }) {
    mockGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/v1/users/')) return { data: profile };
      if (url.startsWith('/api/v1/vehicles/')) return { data: { vehicle: null } };
      throw new Error(`unmocked GET ${url}`);
    });
  }

  it('shows a settled "Friends" state for an existing friend', async () => {
    mockRoutes({ friendStatus: 'accepted' });
    const screen = renderModal();

    await waitFor(() => expect(screen.getByText('Friends')).toBeTruthy());
    expect(screen.queryByText('Add Friend')).toBeNull();
    expect(
      screen.getByLabelText('Friends').props.accessibilityState.disabled,
    ).toBe(true);
  });

  it('shows a disabled "Request Sent" when the viewer already has an outgoing request', async () => {
    mockRoutes({ friendStatus: 'pending', friendRequestDirection: 'outgoing' });
    const screen = renderModal();

    await waitFor(() => expect(screen.getByText('Request Sent')).toBeTruthy());
    expect(
      screen.getByLabelText('Request Sent').props.accessibilityState.disabled,
    ).toBe(true);
  });

  it('offers "Respond to Request" (enabled) when the member already requested the viewer', async () => {
    mockRoutes({ friendStatus: 'pending', friendRequestDirection: 'incoming' });
    const screen = renderModal();

    await waitFor(() => expect(screen.getByText('Respond to Request')).toBeTruthy());
    expect(
      screen.getByLabelText('Respond to Request').props.accessibilityState.disabled,
    ).toBe(false);
  });

  it('keeps the plain "Add Friend" button when there is no relationship', async () => {
    mockRoutes({ friendStatus: null });
    const screen = renderModal();

    await waitFor(() => expect(screen.getByText('Add Friend')).toBeTruthy());
    expect(
      screen.getByLabelText('Add Friend').props.accessibilityState.disabled,
    ).toBe(false);
  });

  it('degrades to "Add Friend" when the profile fetch fails', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    const screen = renderModal();

    await waitFor(() => expect(screen.getByText('Add Friend')).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// Admin PTT channel assignment (Req 26.3) — the Admin moves a member to a
// sub-channel from this sheet; the server pushes the switch to that member.
// ---------------------------------------------------------------------------

describe('MemberDetailModal PTT channel assignment', () => {
  const CHANNELS = [
    { id: 'ch-all', name: 'All', isAll: true, memberIds: ['user-42'] },
    { id: 'ch-lead', name: 'lead', isAll: false, memberIds: [] as string[] },
  ];

  function mockRoutes(channels: unknown = CHANNELS) {
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/channels')) return { data: { channels } };
      if (url.startsWith('/api/v1/users/')) return { data: { friendStatus: null } };
      if (url.startsWith('/api/v1/vehicles/')) return { data: { vehicle: null } };
      if (url.endsWith('/eta')) return { data: { etaSeconds: null } };
      throw new Error(`unmocked GET ${url}`);
    });
  }

  function renderAsAdmin(isCurrentUserAdmin = true) {
    return render(
      <MemberDetailModal
        visible
        member={MEMBER}
        isCurrentUserAdmin={isCurrentUserAdmin}
        onClose={jest.fn()}
      />,
    );
  }

  beforeEach(() => {
    act(() => { useGroupStore.getState().setActiveGroupId('group-7'); });
  });

  afterEach(() => {
    act(() => { useGroupStore.getState().setActiveGroupId(null); });
  });

  it("marks the member's current channel as selected and disabled", async () => {
    mockRoutes();
    const screen = renderAsAdmin();

    await waitFor(() => expect(screen.getByTestId('member-ptt-channels')).toBeTruthy());
    const current = screen.getByLabelText('Move Dana Driver to All Members');
    expect(current.props.accessibilityState.checked).toBe(true);
    expect(current.props.accessibilityState.disabled).toBe(true);
    expect(
      screen.getByLabelText('Move Dana Driver to #lead').props.accessibilityState.checked,
    ).toBe(false);
  });

  it('assigns the member to the tapped channel and moves the selection', async () => {
    mockRoutes();
    mockPost.mockResolvedValue({ data: { channelId: 'ch-lead', userId: 'user-42' } });
    const screen = renderAsAdmin();

    await waitFor(() => expect(screen.getByTestId('member-ptt-channels')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Move Dana Driver to #lead'));
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/api/v1/groups/group-7/channels/ch-lead/members',
      { userId: 'user-42' },
    );
    // Selection follows the move without a refetch — nothing echoes the
    // server's push back to the Admin's own device.
    expect(
      screen.getByLabelText('Move Dana Driver to #lead').props.accessibilityState.checked,
    ).toBe(true);
    expect(
      screen.getByLabelText('Move Dana Driver to All Members').props.accessibilityState.checked,
    ).toBe(false);
  });

  it('keeps the previous selection when the assign call fails', async () => {
    mockRoutes();
    mockPost.mockRejectedValue(new Error('403'));
    const screen = renderAsAdmin();

    await waitFor(() => expect(screen.getByTestId('member-ptt-channels')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Move Dana Driver to #lead'));
    });

    expect(
      screen.getByLabelText('Move Dana Driver to All Members').props.accessibilityState.checked,
    ).toBe(true);
  });

  it('hides the picker from non-Admins', async () => {
    mockRoutes();
    const screen = renderAsAdmin(false);

    await waitFor(() => expect(screen.getByText('No vehicle set')).toBeTruthy());
    await act(async () => {});
    expect(screen.queryByTestId('member-ptt-channels')).toBeNull();
    expect(mockGet).not.toHaveBeenCalledWith(expect.stringContaining('/channels'));
  });

  it('hides the picker when the group has only the "All" channel', async () => {
    mockRoutes([CHANNELS[0]]);
    const screen = renderAsAdmin();

    await waitFor(() => expect(screen.getByText('No vehicle set')).toBeTruthy());
    await act(async () => {});
    expect(screen.queryByTestId('member-ptt-channels')).toBeNull();
  });

  it('renders no selection when the server omits memberIds', async () => {
    mockRoutes(CHANNELS.map(({ memberIds: _ignored, ...c }) => c));
    const screen = renderAsAdmin();

    await waitFor(() => expect(screen.getByTestId('member-ptt-channels')).toBeTruthy());
    expect(
      screen.getByLabelText('Move Dana Driver to All Members').props.accessibilityState.checked,
    ).toBe(false);
  });
});

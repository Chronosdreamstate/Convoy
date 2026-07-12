/**
 * MapScreen helper tests:
 *  - broadcastSosPin / cancelSosPin — the group-vs-standalone SOS branching
 *    (Req 25.3, 25.6, 25.7). The standalone branch was previously dead code:
 *    confirmSos returned early whenever no group was active.
 *  - resolveDistanceOrigin — member-list distances are measured from the
 *    ADMIN's position, not the viewer's (Req 8.4), with a caller-relative
 *    fallback when the admin's position is unknown.
 */

// react-native-maps registers native view components at import time, which the
// jest environment doesn't provide — stub it before importing MapScreen.
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

import { broadcastSosPin, cancelSosPin, resolveDistanceOrigin } from './MapScreen';
import type { SosPin } from '../../services/RallyService';

const pin = (overrides: Partial<SosPin> = {}): SosPin => ({
  id: 'sos-1',
  userId: 'me',
  groupId: null,
  lat: 37.1,
  lng: -122.2,
  type: 'general',
  createdAt: '2026-07-11T00:00:00.000Z',
  ...overrides,
});

describe('broadcastSosPin (Req 25.3 / 25.7)', () => {
  const coord = { lat: 37.1, lng: -122.2 };

  it('broadcasts to the group when a group is active', async () => {
    const groupPin = pin({ groupId: 'g1' });
    const svc = {
      broadcastGroupSos: jest.fn().mockResolvedValue(groupPin),
      broadcastStandaloneSos: jest.fn(),
    };
    await expect(broadcastSosPin(svc, 'g1', coord)).resolves.toBe(groupPin);
    expect(svc.broadcastGroupSos).toHaveBeenCalledWith('g1', 37.1, -122.2);
    expect(svc.broadcastStandaloneSos).not.toHaveBeenCalled();
  });

  it('broadcasts standalone (to friends) when no group is active', async () => {
    const standalonePin = pin();
    const svc = {
      broadcastGroupSos: jest.fn(),
      broadcastStandaloneSos: jest.fn().mockResolvedValue(standalonePin),
    };
    await expect(broadcastSosPin(svc, null, coord)).resolves.toBe(standalonePin);
    expect(svc.broadcastStandaloneSos).toHaveBeenCalledWith(37.1, -122.2);
    expect(svc.broadcastGroupSos).not.toHaveBeenCalled();
  });

  it('treats an empty-string groupId as no group', async () => {
    const svc = {
      broadcastGroupSos: jest.fn(),
      broadcastStandaloneSos: jest.fn().mockResolvedValue(pin()),
    };
    await broadcastSosPin(svc, '', coord);
    expect(svc.broadcastStandaloneSos).toHaveBeenCalledWith(37.1, -122.2);
    expect(svc.broadcastGroupSos).not.toHaveBeenCalled();
  });

  it('propagates standalone API errors so the caller can alert instead of failing silently', async () => {
    const svc = {
      broadcastGroupSos: jest.fn(),
      broadcastStandaloneSos: jest.fn().mockRejectedValue(new Error('429 cooldown')),
    };
    await expect(broadcastSosPin(svc, undefined, coord)).rejects.toThrow('429 cooldown');
  });
});

describe('cancelSosPin (Req 25.6 / 25.7)', () => {
  it('cancels via the group endpoint when a group is active', async () => {
    const svc = {
      cancelSos: jest.fn().mockResolvedValue(undefined),
      cancelStandaloneSos: jest.fn(),
    };
    await cancelSosPin(svc, 'g1', 'sos-1');
    expect(svc.cancelSos).toHaveBeenCalledWith('g1', 'sos-1');
    expect(svc.cancelStandaloneSos).not.toHaveBeenCalled();
  });

  it('cancels via the standalone endpoint when no group is active', async () => {
    const svc = {
      cancelSos: jest.fn(),
      cancelStandaloneSos: jest.fn().mockResolvedValue(undefined),
    };
    await cancelSosPin(svc, null, 'sos-1');
    expect(svc.cancelStandaloneSos).toHaveBeenCalledWith('sos-1');
    expect(svc.cancelSos).not.toHaveBeenCalled();
  });

  it('propagates cancellation errors', async () => {
    const svc = {
      cancelSos: jest.fn(),
      cancelStandaloneSos: jest.fn().mockRejectedValue(new Error('404')),
    };
    await expect(cancelSosPin(svc, '', 'sos-1')).rejects.toThrow('404');
  });
});

describe('resolveDistanceOrigin (Req 8.4)', () => {
  const myLocation = { lat: 10, lng: 10 };
  const admin = { userId: 'admin-1', lat: 20, lng: 21 };
  const other = { userId: 'other-1', lat: 30, lng: 31 };

  it("uses the admin's last known position when the admin is another member", () => {
    expect(resolveDistanceOrigin('admin-1', 'me', myLocation, [other, admin]))
      .toEqual({ lat: 20, lng: 21 });
  });

  it("uses the caller's own fix when the caller IS the admin", () => {
    expect(resolveDistanceOrigin('me', 'me', myLocation, [other])).toBe(myLocation);
  });

  it("falls back to the caller's position when the admin has no known position", () => {
    expect(resolveDistanceOrigin('admin-1', 'me', myLocation, [other])).toBe(myLocation);
  });

  it("falls back to the caller's position when the admin id is unknown", () => {
    expect(resolveDistanceOrigin(null, 'me', myLocation, [other, admin])).toBe(myLocation);
  });

  it('returns null when there is no admin position and no own fix', () => {
    expect(resolveDistanceOrigin('admin-1', 'me', null, [other])).toBeNull();
    expect(resolveDistanceOrigin(null, undefined, null, [])).toBeNull();
  });

  it('returns null when the caller is the admin but has no GPS fix yet', () => {
    // Self is never present in the members list (own location updates are
    // filtered out), so there is nothing to measure from.
    expect(resolveDistanceOrigin('me', 'me', null, [other])).toBeNull();
  });
});

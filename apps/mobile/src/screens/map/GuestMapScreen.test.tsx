/**
 * GuestMapScreen tests:
 *  - Demo-car reduce-motion (Req 39–41): the setInterval ticker that drives
 *    the preview convoy must not run under OS reduce-motion — the demo cars
 *    hold a fixed, staggered mid-route spread instead.
 *  - Funnel routing (Req 1 / 2): "Create Free Account" opens the welcome
 *    carousel; "Sign In" goes straight to email sign-in rather than burying
 *    the returning user in the carousel's last slide.
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// react-native-maps registers native view components at import time, which the
// jest environment doesn't provide — stub it before importing GuestMapScreen.
jest.mock('react-native-maps', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const mockComponent = (name: string) =>
    (props: { children?: unknown }) => ReactActual.createElement(name, props as never, props.children as never);
  return {
    __esModule: true,
    default: mockComponent('MapView'),
    Marker: mockComponent('Marker'),
    Callout: mockComponent('Callout'),
    Polyline: mockComponent('Polyline'),
    PROVIDER_DEFAULT: 'default',
  };
});

// Deny the location permission so the mount effect resolves without needing a
// GPS fix — the demo routes render regardless of permission state.
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockRouterReplace, push: mockRouterPush, back: mockRouterBack }),
}));

let mockReduceMotion = false;
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import GuestMapScreen from './GuestMapScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Coord = { latitude: number; longitude: number };
type TreeNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

/** Walks the rendered tree collecting every <Marker>'s coordinate prop. */
function collectMarkerCoords(node: TreeNode, out: Coord[] = []): Coord[] {
  if (!node || typeof node === 'string') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collectMarkerCoords(n, out));
    return out;
  }
  if (node.type === 'Marker') {
    out.push((node.props as { coordinate: Coord }).coordinate);
  }
  (node.children ?? []).forEach((child) => collectMarkerCoords(child, out));
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReduceMotion = false;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('GuestMapScreen demo cars (reduce motion)', () => {
  it('advances the demo cars on a ticker when motion is allowed', async () => {
    jest.useFakeTimers();
    const screen = render(<GuestMapScreen />);
    // Flush the mount permission request.
    await act(async () => {});

    const before = collectMarkerCoords(screen.toJSON());
    expect(before).toHaveLength(3);

    act(() => {
      jest.advanceTimersByTime(800);
    });

    const after = collectMarkerCoords(screen.toJSON());
    expect(after).toHaveLength(3);
    expect(after).not.toEqual(before);
  });

  it('holds the demo cars at a static staggered spread under OS reduce-motion', async () => {
    mockReduceMotion = true;
    jest.useFakeTimers();
    const screen = render(<GuestMapScreen />);
    await act(async () => {});

    const before = collectMarkerCoords(screen.toJSON());
    expect(before).toHaveLength(3);

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    // No ticking: positions are frozen…
    const after = collectMarkerCoords(screen.toJSON());
    expect(after).toEqual(before);

    // …but still informative: each car sits at a distinct point mid-route,
    // not collapsed onto a shared start position.
    const unique = new Set(after.map((c) => `${c.latitude},${c.longitude}`));
    expect(unique.size).toBe(3);
  });
});

describe('GuestMapScreen funnel routing', () => {
  it('sends "Create Free Account" to the welcome carousel', async () => {
    const screen = render(<GuestMapScreen />);
    await act(async () => {});

    fireEvent.press(screen.getByLabelText('Create free Cortege account'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(auth)/welcome');
  });

  it('sends "Sign In" straight to email sign-in, not the carousel', async () => {
    const screen = render(<GuestMapScreen />);
    await act(async () => {});

    fireEvent.press(screen.getByLabelText('Sign in to Cortege'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(auth)/email');
  });
});

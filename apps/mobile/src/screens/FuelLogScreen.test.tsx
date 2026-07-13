/**
 * Unit tests for FuelLogScreen.
 *
 * Req 21 (fuel tracking) + Req 33 (in-motion list cap):
 *  - While the vehicle is in motion, the fill-up history caps to 4 rows with
 *    the shared "pull over" notice; the summary stats still use every entry.
 *  - The add-fill-up FAB sits on the accent fill, so its icon must use the
 *    fixed ON_ACCENT white, not colors.text.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { useMotionStore } from '../stores/motionStore';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiDelete = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

import FuelLogScreen from './FuelLogScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `f-${i}`,
    date: `2026-07-0${(i % 7) + 1}T12:00:00.000Z`,
    gallons: 10 + i,
    pricePerGallon: 3.5,
    mpg: 28 + i,
  }));
}

async function renderScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FuelLogScreen />);
  });
  return renderer.root;
}

/**
 * Distinct rendered fill-up rows. Composite pressables render their props on
 * both the component node and its host view, so nodes are deduped by label.
 */
function entryRows(root: ReactTestInstance): string[] {
  const labels = root
    .findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Fuel log ')
        && typeof n.props?.onLongPress === 'function',
    )
    .map((n) => n.props.accessibilityLabel as string);
  return [...new Set(labels)];
}

/** True if any Text node's flattened children join to exactly this string. */
function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll((n) => {
    const children = n.props?.children;
    const joined = Array.isArray(children) ? children.join('') : children;
    return joined === text;
  }).length > 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  useMotionStore.setState({ isInMotion: false });
  mockApiGet.mockReset();
});

describe('FuelLogScreen', () => {
  it('renders every fill-up while parked', async () => {
    mockApiGet.mockResolvedValue({ data: { logs: makeLogs(6) } });
    const root = await renderScreen();

    expect(entryRows(root)).toHaveLength(6);
    expect(hasText(root, 'Pull over to see 2 more')).toBe(false);
  });

  it('caps the history to 4 rows with the pull-over notice while in motion (Req 33)', async () => {
    useMotionStore.setState({ isInMotion: true });
    mockApiGet.mockResolvedValue({ data: { logs: makeLogs(6) } });
    const root = await renderScreen();

    expect(entryRows(root)).toHaveLength(4);
    expect(hasText(root, 'Pull over to see 2 more')).toBe(true);
    // Summary stats still reflect ALL entries, not just the visible rows:
    // total gallons = 10+11+12+13+14+15 = 75.0.
    expect(hasText(root, '75.0')).toBe(true);
  });

  it('renders the FAB icon in fixed ON_ACCENT white on the accent fill', async () => {
    mockApiGet.mockResolvedValue({ data: { logs: [] } });
    const root = await renderScreen();

    const fab = root.find(
      (n) => n.props?.accessibilityLabel === 'Add fuel log' && typeof n.props?.onPress === 'function',
    );
    const icon = fab.find((n) => n.props?.name === 'add');
    expect(icon.props.color).toBe('#FFFFFF');
  });
});

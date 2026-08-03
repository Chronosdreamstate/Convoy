/**
 * WaypointManagementScreen — live waypoint updates.
 *
 * The API broadcasts `group:waypoints_updated` whenever the Admin saves, and
 * nothing consumed it: a rider with this screen open kept looking at the stops
 * as they were when it opened. The refresh must not fight a user who is
 * mid-edit, which is the second test here.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: 'g-1' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

const mockApiGet = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...a: unknown[]) => mockApiGet(...a),
    post: jest.fn(async () => ({ data: {} })),
  },
}));

import WaypointManagementScreen from './WaypointManagementScreen';
import { useSocketStore } from '../stores/socketStore';

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Handler[]>();

const socketStub = {
  on: (event: string, fn: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
  off: (event: string, fn?: Handler) => {
    if (!fn) { handlers.delete(event); return; }
    handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== fn));
  },
  emit: jest.fn(),
  connected: true,
};

const wp = (id: string, name: string) => ({ id, name, address: `${name} Road`, type: 'waypoint' as const });

async function fire(event: string, payload: unknown): Promise<void> {
  const fns = handlers.get(event) ?? [];
  if (fns.length === 0) throw new Error(`screen registered no handler for "${event}"`);
  await act(async () => { fns.forEach((fn) => fn(payload)); });
}

async function mountScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<WaypointManagementScreen />); });
  await act(async () => {});
  return renderer.root;
}

/** Composite pressables render their props on both the component and its host
 *  view, so the same row matches more than once — dedupe, keeping order. */
function stopNames(root: ReactTestInstance): string[] {
  const labels = root
    .findAll((n) => typeof n.props?.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Remove '))
    .map((n) => (n.props.accessibilityLabel as string).replace('Remove ', ''));
  return [...new Set(labels)];
}

function pressRemove(root: ReactTestInstance, name: string): Promise<void> {
  const btn = root.findAll(
    (n) => n.props?.accessibilityLabel === `Remove ${name}` && typeof n.props?.onPress === 'function',
  )[0];
  return act(async () => { btn.props.onPress(); });
}

beforeEach(() => {
  handlers.clear();
  mockApiGet.mockReset();
  mockApiGet.mockResolvedValue({ data: { waypoints: [wp('w-1', 'Ridge'), wp('w-2', 'Summit')] } });
  useSocketStore.setState({ socket: socketStub } as never);
});

describe('WaypointManagementScreen live updates', () => {
  it('applies the admin-saved list to a screen with no local edits', async () => {
    const root = await mountScreen();
    expect(stopNames(root)).toEqual(['Ridge', 'Summit']);

    await fire('group:waypoints_updated', {
      groupId: 'g-1',
      waypoints: [wp('w-1', 'Ridge'), wp('w-2', 'Summit'), wp('w-3', 'Overlook')],
    });

    expect(stopNames(root)).toEqual(['Ridge', 'Summit', 'Overlook']);
  });

  it('leaves a half-finished edit alone', async () => {
    const root = await mountScreen();
    await pressRemove(root, 'Summit'); // unsaved local change

    await fire('group:waypoints_updated', {
      groupId: 'g-1',
      waypoints: [wp('w-1', 'Ridge'), wp('w-2', 'Summit'), wp('w-3', 'Overlook')],
    });

    // The user's in-progress list survives; the broadcast is ignored.
    expect(stopNames(root)).toEqual(['Ridge']);
  });

  it('ignores a broadcast for another group', async () => {
    const root = await mountScreen();

    await fire('group:waypoints_updated', { groupId: 'other-group', waypoints: [wp('x-1', 'Elsewhere')] });

    expect(stopNames(root)).toEqual(['Ridge', 'Summit']);
  });
});

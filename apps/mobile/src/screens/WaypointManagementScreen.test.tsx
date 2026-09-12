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
const mockApiPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...a: unknown[]) => mockApiGet(...a),
    post: (...a: unknown[]) => mockApiPost(...a),
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

async function mountScreen(Screen: React.ComponentType = WaypointManagementScreen): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<Screen />); });
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

function pressByLabel(root: ReactTestInstance, label: string): Promise<void> {
  const btn = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];
  if (!btn) throw new Error(`no pressable labelled "${label}"`);
  return act(async () => { btn.props.onPress(); });
}

function typeInto(root: ReactTestInstance, label: string, text: string): Promise<void> {
  const input = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onChangeText === 'function',
  )[0];
  if (!input) throw new Error(`no input labelled "${label}"`);
  return act(async () => { input.props.onChangeText(text); });
}

function inputProp(root: ReactTestInstance, label: string, prop: string): unknown {
  const input = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onChangeText === 'function',
  )[0];
  if (!input) throw new Error(`no input labelled "${label}"`);
  return input.props[prop];
}

/** Add one stop through the real modal flow. */
async function addStop(root: ReactTestInstance, name: string): Promise<void> {
  await pressByLabel(root, 'Add waypoint');
  await typeInto(root, 'Location name', name);
  await pressByLabel(root, 'Add this stop');
}

beforeEach(() => {
  handlers.clear();
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockApiPost.mockResolvedValue({ data: {} });
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

/**
 * The broadcast payload has to satisfy the API's waypointItemSchema
 * (apps/api/src/groups/groups.routes.ts): `id` is required, `name` is capped
 * at 100 characters and `address` at 200. The screen used to post
 * `{name, address, type, lat, lng, order}` with no `id` at all, so the server
 * rejected every save with a 400 and the admin only ever saw the generic
 * "Couldn't broadcast" banner — the route never reached the group.
 */
describe('WaypointManagementScreen broadcast payload', () => {
  it('sends an id for every stop', async () => {
    const root = await mountScreen();
    await addStop(root, 'Overlook');

    await pressByLabel(root, 'Broadcast waypoints to group');

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockApiPost.mock.calls[0] as [string, { waypoints: Array<Record<string, unknown>> }];
    expect(url).toBe('/api/v1/groups/g-1/waypoints');
    expect(body.waypoints).toHaveLength(3);
    for (const w of body.waypoints) {
      expect(typeof w.id).toBe('string');
      expect((w.id as string).length).toBeGreaterThan(0);
      expect((w.id as string).length).toBeLessThanOrEqual(64);
    }
    // Server ids round-trip; the new stop carries the locally minted one.
    expect(body.waypoints.slice(0, 2).map((w) => w.id)).toEqual(['w-1', 'w-2']);
  });

  it('caps the draft fields at the lengths the schema accepts', async () => {
    const root = await mountScreen();
    await pressByLabel(root, 'Add waypoint');

    expect(inputProp(root, 'Location name', 'maxLength')).toBe(100);
    expect(inputProp(root, 'Address', 'maxLength')).toBe(200);
  });
});

/**
 * WaypointManagementScreen — locally-minted waypoint ids must survive a cold
 * start.
 *
 * The ids this screen mints for stops the user adds are *persisted*: the
 * broadcast sends them and GET /waypoints hands them straight back. The mint
 * counter lives in module scope, so it restarts at 1 with the app — a second
 * session adding a stop to a route already holding `local-1` minted `local-1`
 * a second time. Two rows with the same key, and `remove(id)` (which filters
 * on id) then deletes both of them at once.
 *
 * This lives in its own file precisely so the module — and its counter — is
 * loaded fresh, which is the cold start the bug needs.
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

function stopNames(root: ReactTestInstance): string[] {
  const labels = root
    .findAll((n) => typeof n.props?.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Remove '))
    .map((n) => (n.props.accessibilityLabel as string).replace('Remove ', ''));
  return [...new Set(labels)];
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

it('a stop added on a cold start does not collide with a saved local- id', async () => {
  // Ridge was added — and saved — in an earlier session, so it carries the
  // first id that session's counter handed out.
  mockApiGet.mockResolvedValue({
    data: { waypoints: [{ id: 'local-1', name: 'Ridge', address: 'Ridge Road', type: 'waypoint' }] },
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<WaypointManagementScreen />); });
  await act(async () => {});
  const root = renderer.root;

  // First stop this (cold-started) session adds.
  await pressByLabel(root, 'Add waypoint');
  await typeInto(root, 'Location name', 'Summit');
  await pressByLabel(root, 'Add this stop');
  expect(stopNames(root)).toEqual(['Ridge', 'Summit']);

  // Deleting the new stop must leave the saved one alone.
  await pressByLabel(root, 'Remove Summit');
  expect(stopNames(root)).toEqual(['Ridge']);
});

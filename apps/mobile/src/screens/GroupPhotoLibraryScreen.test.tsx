/**
 * GroupPhotoLibraryScreen — opened without a group.
 *
 * `load()` bailed on a missing groupId without clearing `loading` (which starts
 * true), so a link that lost its param left the screen on its skeleton grid
 * forever: no photos, no error, no explanation.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';

let mockParams: { groupId?: string } = { groupId: 'g-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const mockApiGet = jest.fn(async () => ({ data: { photos: [] } }));
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...a: unknown[]) => mockApiGet(...(a as [])),
    delete: jest.fn(async () => ({ data: {} })),
  },
}));

jest.mock('../services/PhotoUploadService', () => ({
  pickAndUploadPhoto: jest.fn(async () => null),
}));

import GroupPhotoLibraryScreen from './GroupPhotoLibraryScreen';
import { useAuthStore } from '../stores/authStore';
import { useSocketStore } from '../stores/socketStore';

async function mountScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<GroupPhotoLibraryScreen />); });
  await act(async () => {});
  return renderer;
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    walk((node as { children?: unknown }).children);
  };
  walk(renderer.toJSON());
  return out.join(' ');
}

function pressable(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { groupId: 'g-1' };
  useAuthStore.setState({
    user: { id: 'u-1', displayName: 'Alex' } as never,
    accessToken: 'tok',
    token: 'tok',
    isAuthenticated: true,
  } as never);
  useSocketStore.setState({ socket: null } as never);
});

describe('GroupPhotoLibraryScreen without a group', () => {
  it('explains the dead end instead of showing the skeleton forever', async () => {
    mockParams = {};
    const renderer = await mountScreen();

    expect(mockApiGet).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('Photos unavailable');
    // Not the "No Photos Yet" empty state either — that would read as a group
    // that simply has no photos.
    expect(renderedText(renderer)).not.toContain('No Photos Yet');
    expect(pressable(renderer.root, 'Go back').length).toBeGreaterThan(0);

    renderer.unmount();
  });

  it('still renders the normal empty state for a real group with no photos', async () => {
    const renderer = await mountScreen();

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/groups/g-1/photos');
    expect(renderedText(renderer)).toContain('No Photos Yet');

    renderer.unmount();
  });
});

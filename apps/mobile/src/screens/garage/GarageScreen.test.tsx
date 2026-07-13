/**
 * Unit tests for the Garage screen's vehicle CRUD flows.
 *
 * Requirement 29 (Garage — multiple vehicle profiles):
 *  - 29.1/29.5: a vehicle profile can carry an optional photo — picking one
 *    uploads it and the saved vehicle includes the returned photoUrl; cards
 *    with a photo render it in place of the type icon.
 *  - 29.2: deleting the active vehicle promotes the oldest remaining vehicle
 *    locally, mirroring the server's reassignment, so the MAIN RIDE badge
 *    doesn't vanish until the next refresh.
 *  - 29.3: editing a vehicle while also setting it as main ride must keep the
 *    just-saved edits in the list (previously the set-as-primary branch spread
 *    the stale row and silently dropped them).
 *  - Mods & Specs are account-level (PATCH /users/me), so the section renders
 *    even with zero vehicles — hidden only when the load itself failed.
 *  - A never-set nickname prefills empty in the edit modal (derived
 *    "Make Model" is the placeholder) and stays null through a save.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/SiriShortcutsService', () => ({
  SiriShortcutsService: { donateAll: jest.fn().mockResolvedValue(undefined) },
}));

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiPatch = jest.fn();
const mockApiDelete = jest.fn();
jest.mock('../../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

const mockRequestPermissions = jest.fn();
const mockLaunchLibrary = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...args),
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchLibrary(...args),
  MediaTypeOptions: { Images: 'Images' },
}));

const mockUploadAsync = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  FileSystemUploadType: { MULTIPART: 'MULTIPART' },
}));

import GarageScreen from './GarageScreen';
import { useAuthStore } from '../../stores/authStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VehicleFixture {
  id: string;
  name: string | null;
  type: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  photoUrl: string | null;
  isActive: boolean;
  createdAt: string;
}

function vehicle(overrides: Partial<VehicleFixture> & { id: string; name: string | null }): VehicleFixture {
  return {
    type: 'Car',
    year: 2020,
    make: null,
    model: null,
    color: null,
    photoUrl: null,
    isActive: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function renderGarage(vehicles: VehicleFixture[], mods: string[] = []): Promise<TestRenderer.ReactTestRenderer> {
  mockApiGet.mockResolvedValue({ data: { vehicles, mods } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<GarageScreen />);
  });
  // Flush the initial GET /api/v1/vehicles load.
  await act(async () => {});
  return renderer;
}

function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const node = root.findAll((n) => n.props?.accessibilityLabel === label)[0];
  expect(node).toBeDefined();
  return node;
}

/** Finds the alert button whose text matches, from the most recent matching alert. */
function alertButton(alertSpy: jest.SpyInstance, title: string, match: RegExp) {
  const call = [...alertSpy.mock.calls].reverse().find((c) => c[0] === title);
  expect(call).toBeDefined();
  const buttons = call![2] as Array<{ text: string; onPress?: () => void | Promise<void> }>;
  const btn = buttons.find((b) => match.test(b.text));
  expect(btn?.onPress).toBeDefined();
  return btn!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GarageScreen — vehicle CRUD flows', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    useAuthStore.setState({ accessToken: 'tok', token: 'tok' });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('deleting the active vehicle promotes the oldest remaining vehicle to main ride', async () => {
    const renderer = await renderGarage([
      vehicle({ id: 'v-b', name: 'Track', createdAt: '2024-01-01T00:00:00.000Z' }),
      vehicle({ id: 'v-a', name: 'Daily', isActive: true, createdAt: '2024-01-02T00:00:00.000Z' }),
      vehicle({ id: 'v-c', name: 'Project', createdAt: '2024-01-03T00:00:00.000Z' }),
    ]);
    mockApiDelete.mockResolvedValue({});

    // Open the action sheet for the active vehicle and choose Delete.
    await act(async () => {
      findByLabel(renderer.root, 'Options for Daily').props.onPress();
    });
    await act(async () => {
      alertButton(alertSpy, 'Daily', /Delete/).onPress!();
    });
    // Confirm the destructive "Delete Vehicle" dialog.
    await act(async () => {
      await alertButton(alertSpy, 'Delete Vehicle', /^Delete$/).onPress!();
    });

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/vehicles/v-a');
    // Oldest remaining (Track, created first) is now the main ride — locally,
    // without a refetch, matching the server's reassignment.
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel === 'Track, main ride').length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel === 'Project, tap to set as main ride').length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel?.startsWith?.('Daily'))).toHaveLength(0);
  });

  it('editing a vehicle while setting it as main ride keeps the saved edits in the list', async () => {
    const renderer = await renderGarage([
      vehicle({ id: 'v-a', name: 'Daily', isActive: true, createdAt: '2024-01-01T00:00:00.000Z' }),
      vehicle({ id: 'v-b', name: 'Track', createdAt: '2024-01-02T00:00:00.000Z' }),
    ]);
    mockApiPatch.mockResolvedValue({
      data: vehicle({ id: 'v-b', name: 'Track Car', isActive: true, createdAt: '2024-01-02T00:00:00.000Z' }),
    });

    // Open the edit modal for the non-active vehicle.
    await act(async () => {
      findByLabel(renderer.root, 'Options for Track').props.onPress();
    });
    await act(async () => {
      alertButton(alertSpy, 'Track', /Edit/).onPress!();
    });

    // Rename it and flip "Set as main ride" on, then save.
    await act(async () => {
      findByLabel(renderer.root, 'Vehicle nickname').props.onChangeText('Track Car');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Set as main ride').props.onValueChange(true);
    });
    await act(async () => {
      findByLabel(renderer.root, 'Save changes').props.onPress();
    });

    expect(mockApiPatch).toHaveBeenCalledWith(
      '/api/v1/vehicles/v-b',
      expect.objectContaining({ name: 'Track Car', primary: true }),
    );
    // The list must show BOTH the new name and the main-ride promotion — the
    // old code dropped the rename until the next refresh.
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel === 'Track Car, main ride').length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel === 'Daily, tap to set as main ride').length).toBeGreaterThan(0);
  });

  it('picking a photo uploads it and includes photoUrl when the vehicle is saved (Req 29.1)', async () => {
    const renderer = await renderGarage([]);
    mockRequestPermissions.mockResolvedValue({ status: 'granted' });
    mockLaunchLibrary.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///local/car.jpg', mimeType: 'image/jpeg' }],
    });
    mockUploadAsync.mockResolvedValue({ body: JSON.stringify({ url: 'https://cdn.example.com/car.jpg' }) });
    mockApiPost.mockResolvedValue({
      data: vehicle({ id: 'v-new', name: 'My Stang', photoUrl: 'https://cdn.example.com/car.jpg' }),
    });

    // Empty garage → open the add-vehicle modal from the empty state.
    await act(async () => {
      findByLabel(renderer.root, 'Add vehicle').props.onPress();
    });

    // Pick a photo — permission → library → upload → staged on the form.
    await act(async () => {
      findByLabel(renderer.root, 'Add vehicle photo').props.onPress();
    });
    expect(mockUploadAsync).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/uploads/photo'),
      'file:///local/car.jpg',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
    // Preview + remove affordance appear once staged.
    expect(findByLabel(renderer.root, 'Vehicle photo preview').props.source).toEqual({ uri: 'https://cdn.example.com/car.jpg' });
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel === 'Remove vehicle photo').length).toBeGreaterThan(0);

    // Name it and save — the POST payload must carry the uploaded photoUrl.
    await act(async () => {
      findByLabel(renderer.root, 'Vehicle nickname').props.onChangeText('My Stang');
    });
    const saveBtn = renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Add vehicle'
        && n.props?.accessibilityState !== undefined
        && typeof n.props?.onPress === 'function',
    )[0];
    expect(saveBtn).toBeDefined();
    await act(async () => {
      saveBtn.props.onPress();
    });

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/vehicles',
      expect.objectContaining({ name: 'My Stang', photoUrl: 'https://cdn.example.com/car.jpg' }),
    );
    // The new card renders the photo in place of the type icon (Req 29.5).
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel === 'Photo of My Stang').length).toBeGreaterThan(0);
  });

  it('a denied photo-library permission surfaces an alert instead of silently doing nothing', async () => {
    const renderer = await renderGarage([]);
    mockRequestPermissions.mockResolvedValue({ status: 'denied' });

    await act(async () => {
      findByLabel(renderer.root, 'Add vehicle').props.onPress();
    });
    await act(async () => {
      findByLabel(renderer.root, 'Add vehicle photo').props.onPress();
    });

    expect(mockLaunchLibrary).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Permission Required',
      expect.stringContaining('photo library'),
    );
  });

  it('shows the account-level Mods & Specs section even with zero vehicles', async () => {
    const renderer = await renderGarage([]);

    // The "Add your first ride" empty state and the mods section coexist —
    // mods live on the user, not on a vehicle.
    expect(renderer.root.findAll((n) => n.props?.children === 'Add your first ride').length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props?.children === 'Mods & Specs').length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props?.children === 'No mods added yet. Show your build!').length).toBeGreaterThan(0);

    // And it's fully usable: adding a mod persists to the account.
    mockApiPatch.mockResolvedValue({ data: {} });
    await act(async () => {
      findByLabel(renderer.root, 'New modification').props.onChangeText('Coilovers');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Add mod').props.onPress();
    });
    expect(mockApiPatch).toHaveBeenCalledWith('/api/v1/users/me', { mods: ['Coilovers'] });
    expect(renderer.root.findAll((n) => n.props?.children === 'Coilovers').length).toBeGreaterThan(0);
  });

  it('hides the mods section for the failed-load state (mods never loaded either)', async () => {
    mockApiGet.mockRejectedValue(new Error('network down'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GarageScreen />);
    });
    await act(async () => {});

    expect(renderer.root.findAll((n) => n.props?.children === "Couldn't load your garage").length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props?.children === 'Mods & Specs')).toHaveLength(0);
  });

  it('edit modal leaves an unset nickname empty, with the derived "Make Model" as placeholder', async () => {
    const renderer = await renderGarage([
      vehicle({ id: 'v-1', name: null, make: 'Ford', model: 'Mustang' }),
    ]);

    await act(async () => {
      findByLabel(renderer.root, 'Options for Ford Mustang').props.onPress();
    });
    await act(async () => {
      alertButton(alertSpy, 'Ford Mustang', /Edit/).onPress!();
    });

    const nickname = findByLabel(renderer.root, 'Vehicle nickname');
    // Never-set nickname → empty value, derived display name as placeholder.
    expect(nickname.props.value).toBe('');
    expect(nickname.props.placeholder).toBe('Ford Mustang');

    // Saving with the field untouched must NOT freeze "Ford Mustang" into a
    // real nickname — the payload keeps name null so it stays derived.
    mockApiPatch.mockResolvedValue({
      data: vehicle({ id: 'v-1', name: null, make: 'Ford', model: 'Mustang' }),
    });
    await act(async () => {
      findByLabel(renderer.root, 'Save changes').props.onPress();
    });
    expect(mockApiPatch).toHaveBeenCalledWith(
      '/api/v1/vehicles/v-1',
      expect.objectContaining({ name: null }),
    );
  });

  it('edit modal still prefills a user-set nickname', async () => {
    const renderer = await renderGarage([
      vehicle({ id: 'v-2', name: 'My Stang', make: 'Ford', model: 'Mustang' }),
    ]);

    await act(async () => {
      findByLabel(renderer.root, 'Options for My Stang').props.onPress();
    });
    await act(async () => {
      alertButton(alertSpy, 'My Stang', /Edit/).onPress!();
    });

    expect(findByLabel(renderer.root, 'Vehicle nickname').props.value).toBe('My Stang');
  });
});

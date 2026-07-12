/**
 * Unit tests for the settings store.
 *
 * Covers:
 *  - default values for every setting
 *  - setSettings applies partial updates without touching other keys
 *  - persistence writes go to SecureStore under the key 'convoy.settings'
 *    (regression: the old key 'convoy:settings' contained ':' which SecureStore
 *    rejects, so settings silently never persisted)
 *  - persisted payload contains only the partialized settings, never functions
 *  - SecureStore failures degrade gracefully (state still updates in memory)
 */

const mockSetItemAsync = jest.fn().mockResolvedValue(undefined);
const mockGetItemAsync = jest.fn().mockResolvedValue(null);
const mockDeleteItemAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-secure-store', () => ({
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
}));

import { useSettingsStore } from './settingsStore';

/** Let zustand/persist's async storage writes settle. */
async function flushPersist(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const DEFAULTS = {
  mapStyle: 'standard',
  hazardAlertDistanceM: 805,
  scenicRouting: false,
  pttMaxSeconds: 30,
  pttVolumePercent: 100,
  distanceUnit: 'miles',
  themeMode: 'system',
  shareLocationWithFriends: false,
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ ...DEFAULTS });
});

describe('defaults', () => {
  it('exposes the documented default for every setting', () => {
    const s = useSettingsStore.getState();
    expect(s.mapStyle).toBe('standard');
    expect(s.hazardAlertDistanceM).toBe(805); // ~0.5 miles
    expect(s.scenicRouting).toBe(false);
    expect(s.pttMaxSeconds).toBe(30);
    expect(s.pttVolumePercent).toBe(100);
    expect(s.distanceUnit).toBe('miles');
    expect(s.themeMode).toBe('system');
    expect(s.shareLocationWithFriends).toBe(false);
  });
});

describe('setSettings', () => {
  it('applies a single-key update without touching other settings', () => {
    useSettingsStore.getState().setSettings({ mapStyle: 'satellite' });

    const s = useSettingsStore.getState();
    expect(s.mapStyle).toBe('satellite');
    expect(s.hazardAlertDistanceM).toBe(805);
    expect(s.distanceUnit).toBe('miles');
    expect(s.themeMode).toBe('system');
  });

  it('applies multi-key updates atomically', () => {
    useSettingsStore.getState().setSettings({
      distanceUnit: 'km',
      themeMode: 'dark',
      scenicRouting: true,
      pttVolumePercent: 40,
    });

    const s = useSettingsStore.getState();
    expect(s.distanceUnit).toBe('km');
    expect(s.themeMode).toBe('dark');
    expect(s.scenicRouting).toBe(true);
    expect(s.pttVolumePercent).toBe(40);
    // untouched keys keep their values
    expect(s.mapStyle).toBe('standard');
    expect(s.pttMaxSeconds).toBe(30);
  });

  it('sequential updates accumulate', () => {
    const { setSettings } = useSettingsStore.getState();
    setSettings({ mapStyle: 'hybrid' });
    setSettings({ hazardAlertDistanceM: 1609 });
    setSettings({ shareLocationWithFriends: true });

    const s = useSettingsStore.getState();
    expect(s.mapStyle).toBe('hybrid');
    expect(s.hazardAlertDistanceM).toBe(1609);
    expect(s.shareLocationWithFriends).toBe(true);
  });
});

describe('persistence', () => {
  it("writes to SecureStore under 'convoy.settings' (SecureStore-legal key, no ':')", async () => {
    useSettingsStore.getState().setSettings({ themeMode: 'light' });
    await flushPersist();

    expect(mockSetItemAsync).toHaveBeenCalled();
    const [key] = mockSetItemAsync.mock.calls[mockSetItemAsync.mock.calls.length - 1] as [string, string];
    expect(key).toBe('convoy.settings');
    // SecureStore only allows alphanumerics, ".", "-", "_"
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('persists only the partialized settings values, never functions', async () => {
    useSettingsStore.getState().setSettings({ distanceUnit: 'km', pttMaxSeconds: 15 });
    await flushPersist();

    const [, value] = mockSetItemAsync.mock.calls[mockSetItemAsync.mock.calls.length - 1] as [string, string];
    const parsed = JSON.parse(value) as { state: Record<string, unknown> };

    expect(parsed.state).toEqual({
      mapStyle: 'standard',
      hazardAlertDistanceM: 805,
      scenicRouting: false,
      pttMaxSeconds: 15,
      pttVolumePercent: 100,
      distanceUnit: 'km',
      themeMode: 'system',
      shareLocationWithFriends: false,
    });
    expect(parsed.state).not.toHaveProperty('setSettings');
  });

  it('still updates in-memory state when SecureStore writes fail', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSetItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'));

    useSettingsStore.getState().setSettings({ scenicRouting: true });
    await flushPersist();

    expect(useSettingsStore.getState().scenicRouting).toBe(true);
    warnSpy.mockRestore();
  });

  it('read failures during rehydration resolve to null instead of throwing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(useSettingsStore.persist.rehydrate()).resolves.not.toThrow();
    // Defaults survive a failed rehydration
    expect(useSettingsStore.getState().mapStyle).toBe('standard');
    warnSpy.mockRestore();
  });
});

describe('resetForSignOut', () => {
  it('resets every account-level setting to its fresh-install default', () => {
    useSettingsStore.setState({
      mapStyle: 'hybrid',
      hazardAlertDistanceM: 5000,
      scenicRouting: true,
      pttMaxSeconds: 60,
      pttVolumePercent: 20,
      distanceUnit: 'km',
      shareLocationWithFriends: true,
    });

    useSettingsStore.getState().resetForSignOut();

    const s = useSettingsStore.getState();
    expect(s.mapStyle).toBe('standard');
    expect(s.hazardAlertDistanceM).toBe(805);
    expect(s.scenicRouting).toBe(false);
    expect(s.pttMaxSeconds).toBe(30);
    expect(s.pttVolumePercent).toBe(100);
    expect(s.distanceUnit).toBe('miles');
    expect(s.shareLocationWithFriends).toBe(false);
  });

  it('keeps device-level themeMode across sign-out', () => {
    useSettingsStore.setState({ themeMode: 'dark', mapStyle: 'satellite' });

    useSettingsStore.getState().resetForSignOut();

    expect(useSettingsStore.getState().themeMode).toBe('dark');
    expect(useSettingsStore.getState().mapStyle).toBe('standard');
  });

  it('rewrites the persisted SecureStore copy with the defaults, not just memory', async () => {
    useSettingsStore.setState({ shareLocationWithFriends: true, distanceUnit: 'km' });

    useSettingsStore.getState().resetForSignOut();
    await flushPersist();

    expect(mockSetItemAsync).toHaveBeenCalled();
    const [key, value] = mockSetItemAsync.mock.calls[mockSetItemAsync.mock.calls.length - 1] as [string, string];
    expect(key).toBe('convoy.settings');
    const parsed = JSON.parse(value) as { state: Record<string, unknown> };
    expect(parsed.state.shareLocationWithFriends).toBe(false);
    expect(parsed.state.distanceUnit).toBe('miles');
  });
});

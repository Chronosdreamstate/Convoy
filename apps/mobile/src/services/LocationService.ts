import * as Location from 'expo-location';

export const LOCATION_TASK_NAME = 'convoy-background-location';

type LocationCallback = (loc: { lat: number; lng: number; heading: number; speedKph: number; ts: number }) => void;
let _onLocation: LocationCallback | null = null;

/*
 * Background tracking via expo-task-manager (not yet installed).
 * Install with: npx expo install expo-task-manager
 * Then uncomment:
 *
 * import * as TaskManager from 'expo-task-manager';
 * TaskManager.defineTask(LOCATION_TASK_NAME, ({ data, error }) => {
 *   if (error || !data || !_onLocation) return;
 *   const { locations } = data as { locations: Location.LocationObject[] };
 *   const loc = locations[locations.length - 1];
 *   _onLocation({
 *     lat: loc.coords.latitude, lng: loc.coords.longitude,
 *     heading: loc.coords.heading ?? 0,
 *     speedKph: (loc.coords.speed ?? 0) * 3.6,
 *     ts: loc.timestamp,
 *   });
 * });
 */

let _foregroundSub: Location.LocationSubscription | null = null;
let _backgroundStarted = false;

export const LocationService = {
  setCallback(cb: LocationCallback) { _onLocation = cb; },
  clearCallback() { _onLocation = null; },

  async startTracking(): Promise<void> {
    const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'denied' as const }));
    if (bg.status === 'granted') {
      await this._startBackground();
    } else {
      await this._startForeground();
    }
  },

  async _startBackground(): Promise<void> {
    /*
     * When expo-task-manager is installed, replace this block:
     * const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
     * if (!isRunning) {
     *   await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
     *     accuracy: Location.Accuracy.Balanced,
     *     timeInterval: 3000,
     *     distanceInterval: 10,
     *     foregroundService: {
     *       notificationTitle: 'CONVOY is tracking your location',
     *       notificationBody: 'Your crew can see you on the map',
     *       notificationColor: '#DC143C',
     *     },
     *     pausesUpdatesAutomatically: false,
     *   });
     *   _backgroundStarted = true;
     * }
     */
    await this._startForeground();
  },

  async _startForeground(): Promise<void> {
    if (_foregroundSub) return;
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    _foregroundSub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 10 },
      (loc) => {
        if (!_onLocation) return;
        _onLocation({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          heading: loc.coords.heading ?? 0,
          speedKph: (loc.coords.speed ?? 0) * 3.6,
          ts: loc.timestamp,
        });
      },
    );
  },

  async stopTracking(): Promise<void> {
    if (_backgroundStarted) {
      // When expo-task-manager is installed, uncomment:
      // const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
      // if (isRunning) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      _backgroundStarted = false;
    }
    if (_foregroundSub) { _foregroundSub.remove(); _foregroundSub = null; }
    _onLocation = null;
  },

  get isTracking(): boolean {
    return _backgroundStarted || _foregroundSub !== null;
  },
};

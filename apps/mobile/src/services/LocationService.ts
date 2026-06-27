import * as Location from 'expo-location';

export const LOCATION_TASK_NAME = 'convoy-background-location';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface LocationData {
  lat: number;
  lng: number;
  heading: number;
  speed_kph: number;
  ts: number;
}

export interface ILocationDB {
  init(): Promise<void>;
  saveLastKnownLocation(userId: string, location: LocationData): Promise<void>;
  getAllLastKnownLocations(): Promise<Map<string, LocationData>>;
}

// ---------------------------------------------------------------------------
// Socket interface for dependency injection
// ---------------------------------------------------------------------------

interface SocketLike {
  connected: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, data: LocationData): any;
}

// ---------------------------------------------------------------------------
// LocationService class (testable, dependency-injected)
// ---------------------------------------------------------------------------

/**
 * Handles GPS update throttling (≤1 emit per 3 s) and DB caching.
 * Instantiate with a socket and DB for testing; use static methods for the
 * singleton / MapScreen integration.
 */
export class LocationService {
  private readonly socket: SocketLike;
  private readonly db: ILocationDB;
  private readonly userId: string;
  private lastEmitTs: number | null = null;
  private static readonly THROTTLE_MS = 3_000;

  constructor(socket: SocketLike, db: ILocationDB, userId: string) {
    this.socket = socket;
    this.db = db;
    this.userId = userId;
  }

  /** Returns true if the update should be suppressed (within the 3-second window). */
  shouldThrottle(ts: number): boolean {
    if (this.lastEmitTs === null) {
      this.lastEmitTs = ts;
      return false;
    }
    if (ts - this.lastEmitTs >= LocationService.THROTTLE_MS) {
      this.lastEmitTs = ts;
      return false;
    }
    return true;
  }

  /** Process one GPS fix: always persist to DB; emit to socket if not throttled. */
  async handleGPSUpdate(location: LocationData): Promise<void> {
    await this.db.saveLastKnownLocation(this.userId, location);
    if (!this.shouldThrottle(location.ts) && this.socket.connected) {
      this.socket.emit('location:update', location);
    }
  }

  // ---------------------------------------------------------------------------
  // Static singleton interface (used by MapScreen / DriveService)
  // ---------------------------------------------------------------------------

  private static _onLocation: LocationCallback | null = null;
  private static _foregroundSub: Location.LocationSubscription | null = null;
  private static _backgroundStarted = false;

  static setCallback(cb: LocationCallback) { LocationService._onLocation = cb; }
  static clearCallback() { LocationService._onLocation = null; }

  static async startTracking(): Promise<void> {
    const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'denied' as const }));
    if (bg.status === 'granted') {
      await LocationService._startBackground();
    } else {
      await LocationService._startForeground();
    }
  }

  static async _startBackground(): Promise<void> {
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
     *   LocationService._backgroundStarted = true;
     * }
     */
    await LocationService._startForeground();
  }

  static async _startForeground(): Promise<void> {
    if (LocationService._foregroundSub) return;
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[LocationService] Foreground location permission denied — GPS tracking unavailable');
      return;
    }
    LocationService._foregroundSub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 10 },
      (loc) => {
        if (!LocationService._onLocation) return;
        LocationService._onLocation({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          heading: loc.coords.heading ?? 0,
          speedKph: (loc.coords.speed ?? 0) * 3.6,
          ts: loc.timestamp,
        });
      },
    );
  }

  static async stopTracking(): Promise<void> {
    if (LocationService._backgroundStarted) {
      // When expo-task-manager is installed, uncomment:
      // const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
      // if (isRunning) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      LocationService._backgroundStarted = false;
    }
    if (LocationService._foregroundSub) {
      LocationService._foregroundSub.remove();
      LocationService._foregroundSub = null;
    }
    LocationService._onLocation = null;
  }

  static get isTracking(): boolean {
    return LocationService._backgroundStarted || LocationService._foregroundSub !== null;
  }
}

// ---------------------------------------------------------------------------
// Legacy callback type (used by MapScreen)
// ---------------------------------------------------------------------------

type LocationCallback = (loc: {
  lat: number;
  lng: number;
  heading: number;
  speedKph: number;
  ts: number;
}) => void;

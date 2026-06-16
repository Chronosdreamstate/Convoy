import * as ExpoLocation from 'expo-location';
import * as SQLite from 'expo-sqlite';
import { Socket } from 'socket.io-client';
import { useLocationStore } from '../stores/locationStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocationData {
  lat: number;
  lng: number;
  heading: number;
  speed_kph: number;
  ts: number;
}

/** Thin abstraction over SQLite so the service is testable without expo-sqlite. */
export interface ILocationDB {
  init(): Promise<void>;
  saveLastKnownLocation(userId: string, location: LocationData): Promise<void>;
  getAllLastKnownLocations(): Promise<Map<string, LocationData>>;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SQLiteLocationDB implements ILocationDB {
  private db: SQLite.SQLiteDatabase | null = null;
  private readonly dbName: string;

  constructor(dbName = 'convoy.db') {
    this.dbName = dbName;
  }

  async init(): Promise<void> {
    this.db = await SQLite.openDatabaseAsync(this.dbName);
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS offline_locations (
        user_id   TEXT PRIMARY KEY,
        lat       REAL NOT NULL,
        lng       REAL NOT NULL,
        heading   REAL NOT NULL,
        speed_kph REAL NOT NULL,
        ts        INTEGER NOT NULL
      );
    `);
  }

  async saveLastKnownLocation(userId: string, location: LocationData): Promise<void> {
    if (!this.db) throw new Error('LocationDB not initialised — call init() first');
    // Always keep the latest position; overwrite unconditionally so the offline
    // view shows where the member was last seen, regardless of arrival order.
    await this.db.runAsync(
      `INSERT INTO offline_locations (user_id, lat, lng, heading, speed_kph, ts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         lat       = excluded.lat,
         lng       = excluded.lng,
         heading   = excluded.heading,
         speed_kph = excluded.speed_kph,
         ts        = excluded.ts`,
      [userId, location.lat, location.lng, location.heading, location.speed_kph, location.ts],
    );
  }

  async getAllLastKnownLocations(): Promise<Map<string, LocationData>> {
    if (!this.db) throw new Error('LocationDB not initialised — call init() first');
    const rows = await this.db.getAllAsync<{
      user_id: string;
      lat: number;
      lng: number;
      heading: number;
      speed_kph: number;
      ts: number;
    }>('SELECT * FROM offline_locations');
    const map = new Map<string, LocationData>();
    for (const row of rows) {
      map.set(row.user_id, {
        lat: row.lat,
        lng: row.lng,
        heading: row.heading,
        speed_kph: row.speed_kph,
        ts: row.ts,
      });
    }
    return map;
  }
}

// ---------------------------------------------------------------------------
// LocationService
// ---------------------------------------------------------------------------

const THROTTLE_MS = 3_000; // max 1 socket emit per 3 seconds (Property 13)
const GPS_UPDATE_INTERVAL_MS = 1_000; // 1 Hz

export class LocationService {
  private lastEmitTime = -THROTTLE_MS; // ensures first call always emits
  private subscription: ExpoLocation.LocationSubscription | null = null;

  constructor(
    private readonly socket: Pick<Socket, 'emit' | 'connected'>,
    private readonly locationDB: ILocationDB,
    private readonly userId: string,
  ) {}

  /**
   * Returns true if the emit should be skipped (throttled).
   * Exposed for property testing.
   */
  shouldThrottle(now: number): boolean {
    if (now - this.lastEmitTime < THROTTLE_MS) return true;
    this.lastEmitTime = now;
    return false;
  }

  /** Process a single GPS fix: update store, persist offline cache, maybe emit. */
  async handleGPSUpdate(location: LocationData): Promise<void> {
    // Always update the Zustand store (1 Hz)
    useLocationStore.getState().updateMyLocation({
      lat: location.lat,
      lng: location.lng,
      heading: location.heading,
      speedKph: location.speed_kph,
      ts: location.ts,
      receivedAt: Date.now(),
    });

    // Always persist last-known position to SQLite
    await this.locationDB.saveLastKnownLocation(this.userId, location);

    // Emit to socket at most once per 3 seconds (Req 8.1)
    if (this.socket.connected && !this.shouldThrottle(Date.now())) {
      this.socket.emit('location:update', location);
    }
  }

  /** Start watching the device GPS. Call stop() to clean up. */
  async start(): Promise<'granted' | 'denied'> {
    if (this.subscription) return 'granted'; // already running

    const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
    if (status !== 'granted') return 'denied';

    this.subscription = await ExpoLocation.watchPositionAsync(
      {
        accuracy: ExpoLocation.Accuracy.BestForNavigation,
        timeInterval: GPS_UPDATE_INTERVAL_MS,
        distanceInterval: 0,
      },
      (pos) => {
        this.handleGPSUpdate({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: pos.coords.heading ?? 0,
          speed_kph: (pos.coords.speed ?? 0) * 3.6, // m/s → km/h
          ts: pos.timestamp,
        }).catch(() => {
          // GPS callback errors are non-fatal; last-known position may be stale
        });
      },
    );
    return 'granted';
  }

  stop(): void {
    this.subscription?.remove();
    this.subscription = null;
  }
}

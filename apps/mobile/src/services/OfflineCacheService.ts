/**
 * OfflineCacheService — map tile prefetch and SQLite offline queue writes.
 * Requirements: 4.1–4.4, 11.9, 14.1–14.4, 19.7
 */

import * as SQLite from 'expo-sqlite';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface OfflineHazard {
  id: string;
  lat: number;
  lng: number;
  type: string;
  description?: string;
  createdAt: number; // epoch ms
}

export interface OfflineDrive {
  id: string;
  groupId: string;
  startedAt: number; // epoch ms
  endedAt: number;   // epoch ms
  distanceMeters: number;
  durationSeconds: number;
  routeTrace: string;        // JSON-serialized GeoJSON LineString
  avgSpeedKph: number | null;
  topSpeedKph: number | null;
  memberCount: number;
}

export interface OfflinePack {
  name: string;
  sizeBytes: number;
  createdAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// Injectable interfaces (enable unit testing without real SQLite / Mapbox)
// ---------------------------------------------------------------------------

export interface IOfflineDB {
  init(): Promise<void>;
  saveHazard(hazard: OfflineHazard): Promise<void>;
  getPendingHazards(): Promise<OfflineHazard[]>;
  clearHazards(ids: string[]): Promise<void>;
  saveDrive(drive: OfflineDrive): Promise<void>;
  getPendingDrives(): Promise<OfflineDrive[]>;
  clearDrives(ids: string[]): Promise<void>;
}

export interface IMapOfflineManager {
  getPacks(): Promise<OfflinePack[]>;
  createPack(name: string, bounds: [[number, number], [number, number]], createdAt: number): Promise<void>;
  deletePack(name: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQLite production implementation
// ---------------------------------------------------------------------------

export class SQLiteOfflineDB implements IOfflineDB {
  private db: SQLite.SQLiteDatabase | null = null;
  private readonly dbName: string;

  constructor(dbName = 'convoy_offline.db') {
    this.dbName = dbName;
  }

  async init(): Promise<void> {
    this.db = await SQLite.openDatabaseAsync(this.dbName);
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS offline_hazards (
        id          TEXT PRIMARY KEY,
        lat         REAL NOT NULL,
        lng         REAL NOT NULL,
        type        TEXT NOT NULL,
        description TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS offline_drives (
        id               TEXT PRIMARY KEY,
        group_id         TEXT NOT NULL,
        started_at       INTEGER NOT NULL,
        ended_at         INTEGER NOT NULL,
        distance_meters  REAL NOT NULL,
        duration_seconds REAL NOT NULL,
        route_trace      TEXT NOT NULL DEFAULT '{"type":"LineString","coordinates":[]}',
        avg_speed_kph    REAL,
        top_speed_kph    REAL,
        member_count     INTEGER NOT NULL DEFAULT 1
      );
    `);
  }

  async saveHazard(hazard: OfflineHazard): Promise<void> {
    this.ensureDB();
    await this.db!.runAsync(
      `INSERT OR REPLACE INTO offline_hazards
         (id, lat, lng, type, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [hazard.id, hazard.lat, hazard.lng, hazard.type, hazard.description ?? null, hazard.createdAt],
    );
  }

  async getPendingHazards(): Promise<OfflineHazard[]> {
    this.ensureDB();
    const rows = await this.db!.getAllAsync<{
      id: string; lat: number; lng: number; type: string;
      description: string | null; created_at: number;
    }>('SELECT * FROM offline_hazards ORDER BY created_at ASC');
    return rows.map((r) => ({
      id: r.id,
      lat: r.lat,
      lng: r.lng,
      type: r.type,
      description: r.description ?? undefined,
      createdAt: r.created_at,
    }));
  }

  async clearHazards(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    this.ensureDB();
    const placeholders = ids.map(() => '?').join(',');
    await this.db!.runAsync(`DELETE FROM offline_hazards WHERE id IN (${placeholders})`, ids);
  }

  async saveDrive(drive: OfflineDrive): Promise<void> {
    this.ensureDB();
    await this.db!.runAsync(
      `INSERT OR REPLACE INTO offline_drives
         (id, group_id, started_at, ended_at, distance_meters, duration_seconds,
          route_trace, avg_speed_kph, top_speed_kph, member_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        drive.id, drive.groupId, drive.startedAt, drive.endedAt,
        drive.distanceMeters, drive.durationSeconds,
        drive.routeTrace, drive.avgSpeedKph ?? null, drive.topSpeedKph ?? null, drive.memberCount,
      ],
    );
  }

  async getPendingDrives(): Promise<OfflineDrive[]> {
    this.ensureDB();
    const rows = await this.db!.getAllAsync<{
      id: string; group_id: string; started_at: number; ended_at: number;
      distance_meters: number; duration_seconds: number; route_trace: string;
      avg_speed_kph: number | null; top_speed_kph: number | null; member_count: number;
    }>('SELECT * FROM offline_drives ORDER BY started_at ASC');
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      distanceMeters: r.distance_meters,
      durationSeconds: r.duration_seconds,
      routeTrace: r.route_trace,
      avgSpeedKph: r.avg_speed_kph,
      topSpeedKph: r.top_speed_kph,
      memberCount: r.member_count,
    }));
  }

  async clearDrives(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    this.ensureDB();
    const placeholders = ids.map(() => '?').join(',');
    await this.db!.runAsync(`DELETE FROM offline_drives WHERE id IN (${placeholders})`, ids);
  }

  private ensureDB(): void {
    if (!this.db) throw new Error('SQLiteOfflineDB not initialised — call init() first');
  }
}

// ---------------------------------------------------------------------------
// Pure helper — bounding box + buffer
// ---------------------------------------------------------------------------

const DEGREES_PER_MILE = 1 / 69; // approximate for latitude

export function computeBoundsWithBuffer(
  coordinates: [number, number][],
  bufferMiles: number,
): [[number, number], [number, number]] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  const buf = bufferMiles * DEGREES_PER_MILE;
  return [
    [minLng - buf, minLat - buf],
    [maxLng + buf, maxLat + buf],
  ];
}

// ---------------------------------------------------------------------------
// OfflineCacheService
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE_MB = 500;
const TILE_BUFFER_MILES = 10;

export class OfflineCacheService {
  private readonly db: IOfflineDB;
  private readonly mapManager: IMapOfflineManager;
  readonly maxSizeMB: number;

  constructor(db: IOfflineDB, mapManager: IMapOfflineManager, maxSizeMB = DEFAULT_MAX_SIZE_MB) {
    this.db = db;
    this.mapManager = mapManager;
    this.maxSizeMB = maxSizeMB;
  }

  /**
   * Prefetch tiles covering routeCoordinates + 10-mile buffer.
   * Evicts the oldest pack first if the 500 MB cap is reached.
   * @param coordinates  [lng, lat] pairs from route geometry (GeoJSON order)
   * @param routeName    Unique name for the offline pack
   * @param now          Current epoch ms (injectable for testing)
   */
  async prefetchTilesForRoute(
    coordinates: [number, number][],
    routeName: string,
    now: number,
  ): Promise<void> {
    if (coordinates.length === 0) return;

    const packs = await this.mapManager.getPacks();
    const totalMB = packs.reduce((sum, p) => sum + p.sizeBytes, 0) / (1024 * 1024);

    if (totalMB >= this.maxSizeMB) {
      // Evict oldest pack to stay within cap (Req 4.3)
      const oldest = packs.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) await this.mapManager.deletePack(oldest.name);
    }

    const bounds = computeBoundsWithBuffer(coordinates, TILE_BUFFER_MILES);
    await this.mapManager.createPack(routeName, bounds, now);
  }

  /** Queue a hazard report for later sync (Req 11.9). */
  async saveOfflineHazard(hazard: OfflineHazard): Promise<void> {
    await this.db.saveHazard(hazard);
  }

  /** Queue a completed drive record for later sync (Req 14.1). */
  async saveOfflineDrive(drive: OfflineDrive): Promise<void> {
    await this.db.saveDrive(drive);
  }
}

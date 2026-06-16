/**
 * DriveService — buffers GPS coordinates during a group session and
 * assembles a Drive_History record when the session ends.
 * Requirements: 19.1, 19.7
 */

import { OfflineDrive } from './OfflineCacheService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackPoint {
  lat: number;
  lng: number;
  speedKph: number;
  ts: number; // epoch ms
}

export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: [number, number][]; // [lng, lat]
}

export interface DriveStats {
  routeTrace: GeoJSONLineString;
  distanceM: number;
  durationS: number;
  avgSpeedKph: number | null;
  topSpeedKph: number | null;
}

export interface DriveBody {
  groupId: string | null;
  routeTrace: GeoJSONLineString;
  distanceM: number;
  durationS: number;
  avgSpeedKph: number | null;
  topSpeedKph: number | null;
  memberCount: number;
  startedAt: string;
  endedAt: string;
}

export interface DriveRecord extends DriveBody {
  id: string;
  userId: string;
  summaryCardUrl: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Pure computation — exported for property testing
// ---------------------------------------------------------------------------

/** Haversine distance between two lat/lng points, in meters. */
export function haversineDistanceM(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compute drive stats from an ordered array of track points. Returns null if < 2 points. */
export function computeDriveStats(points: TrackPoint[]): DriveStats | null {
  if (points.length < 2) return null;

  let distanceM = 0;
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineDistanceM(
      points[i - 1].lat, points[i - 1].lng,
      points[i].lat, points[i].lng,
    );
  }

  const durationS = Math.round((points[points.length - 1].ts - points[0].ts) / 1000);
  const avgSpeedKph = durationS > 0 ? (distanceM / 1000) / (durationS / 3600) : null;
  const topSpeedKph = points.reduce((max, p) => Math.max(max, p.speedKph), 0);

  return {
    routeTrace: {
      type: 'LineString',
      coordinates: points.map((p) => [p.lng, p.lat]),
    },
    distanceM: Math.round(distanceM),
    durationS,
    avgSpeedKph: avgSpeedKph !== null ? Math.round(avgSpeedKph * 10) / 10 : null,
    topSpeedKph: Math.round(topSpeedKph * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface IDriveOfflineCache {
  saveDrive(drive: OfflineDrive): Promise<void>;
}

export interface IDriveApiClient {
  postDrive(body: DriveBody): Promise<DriveRecord>;
}

// ---------------------------------------------------------------------------
// DriveService
// ---------------------------------------------------------------------------

export class DriveService {
  private points: TrackPoint[] = [];
  private sessionStartMs: number | null = null;

  /** Call when a group session begins. */
  startSession(nowMs: number = Date.now()): void {
    this.points = [];
    this.sessionStartMs = nowMs;
  }

  /** Feed each GPS fix — call this from LocationService / MapScreen every ~3 s. */
  addPoint(lat: number, lng: number, speedKph: number, ts: number = Date.now()): void {
    if (this.sessionStartMs === null) return;
    this.points.push({ lat, lng, speedKph, ts });
  }

  /** Current buffered point count — useful for testing. */
  get pointCount(): number {
    return this.points.length;
  }

  /**
   * Call when `group:ended` fires. Assembles stats, saves to SQLite, then
   * attempts an API POST. Returns the server record on success, null on failure
   * (sync will retry from SQLite on reconnect — Req 19.7).
   */
  async finishSession(params: {
    groupId: string | null;
    memberCount: number;
    offlineCache: IDriveOfflineCache;
    api: IDriveApiClient;
    isOnline: () => boolean;
    nowMs?: number;
  }): Promise<DriveRecord | null> {
    const nowMs = params.nowMs ?? Date.now();
    if (this.sessionStartMs === null) return null;

    const stats = computeDriveStats(this.points);
    const startedAt = new Date(this.sessionStartMs).toISOString();
    const endedAt = new Date(nowMs).toISOString();

    // Always save to SQLite first (Req 19.7)
    const offlineDrive: OfflineDrive = {
      id: `drive-offline-${this.sessionStartMs}`,
      groupId: params.groupId ?? '',
      startedAt: this.sessionStartMs,
      endedAt: nowMs,
      distanceMeters: stats?.distanceM ?? 0,
      durationSeconds: stats?.durationS ?? Math.round((nowMs - this.sessionStartMs) / 1000),
      routeTrace: stats ? JSON.stringify(stats.routeTrace) : '{"type":"LineString","coordinates":[]}',
      avgSpeedKph: stats?.avgSpeedKph ?? null,
      topSpeedKph: stats?.topSpeedKph ?? null,
      memberCount: params.memberCount,
    };
    await params.offlineCache.saveDrive(offlineDrive);

    this.reset();

    if (!stats) return null;

    if (params.isOnline()) {
      try {
        return await params.api.postDrive({
          groupId: params.groupId,
          routeTrace: stats.routeTrace,
          distanceM: stats.distanceM,
          durationS: stats.durationS,
          avgSpeedKph: stats.avgSpeedKph,
          topSpeedKph: stats.topSpeedKph,
          memberCount: params.memberCount,
          startedAt,
          endedAt,
        });
      } catch {
        return null; // SyncService will retry from SQLite
      }
    }

    return null;
  }

  private reset(): void {
    this.points = [];
    this.sessionStartMs = null;
  }
}

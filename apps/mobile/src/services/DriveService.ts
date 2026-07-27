/**
 * DriveService — buffers GPS coordinates during a group session and
 * assembles a Drive_History record when the session ends.
 * Requirements: 19.1, 19.7
 */

import { OfflineDrive } from './OfflineCacheService';
import { haversineDistanceM } from '../utils/geo';

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

export { haversineDistanceM };

/**
 * Hard cap on uploaded route-trace points. Mirrors the API's routeTrace
 * validation limit (50k) — a multi-day drive at one fix every ~3 s crosses it
 * after roughly 1.7 days, and would also blow the route body size limit.
 */
export const MAX_TRACE_POINTS = 50_000;

/**
 * Uniformly downsample `points` to at most `maxPoints`, always preserving the
 * first and last elements and the original order. Index selection is
 * round(i * (len-1) / (maxPoints-1)) — an even keep-every-Nth spread that can
 * never return more than maxPoints entries. Returns the input array unchanged
 * (same reference) when it is already within budget.
 */
export function downsampleTrace<T>(points: T[], maxPoints: number = MAX_TRACE_POINTS): T[] {
  if (maxPoints < 2) throw new RangeError('maxPoints must be at least 2');
  if (points.length <= maxPoints) return points;

  const lastIdx = points.length - 1;
  const out: T[] = [];
  let prevIdx = -1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * lastIdx) / (maxPoints - 1));
    if (idx !== prevIdx) {
      out.push(points[idx]);
      prevIdx = idx;
    }
  }
  return out;
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
  const rawTopSpeed = points.reduce((max, p) => Math.max(max, p.speedKph), 0);
  // Return null when all speed readings are 0 — device speed was unavailable, not literally 0 kph
  const topSpeedKph = rawTopSpeed > 0 ? Math.round(rawTopSpeed * 10) / 10 : null;

  return {
    routeTrace: {
      type: 'LineString',
      // Distance/duration/speeds above use EVERY buffered point; only the
      // uploaded polyline is thinned, so stats stay exact while the trace can
      // never exceed the API's 50k-point routeTrace cap (Req 19.1).
      coordinates: downsampleTrace(points).map((p) => [p.lng, p.lat]),
    },
    distanceM: Math.round(distanceM),
    durationS,
    avgSpeedKph: avgSpeedKph !== null ? Math.round(avgSpeedKph * 10) / 10 : null,
    topSpeedKph,
  };
}

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface IDriveOfflineCache {
  saveDrive(drive: OfflineDrive): Promise<void>;
  /**
   * Remove drives already confirmed persisted server-side. finishSession()
   * calls this after a successful online POST so SyncService's later queue
   * drain doesn't re-POST the same drive and create a duplicate Drive_History
   * record (the API's POST /drives is a plain INSERT with no idempotency key).
   */
  clearDrives(ids: string[]): Promise<void>;
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
  private claimedEndGroupId: string | null = null;

  /** Call when a group session begins. */
  startSession(nowMs: number = Date.now()): void {
    this.points = [];
    this.sessionStartMs = nowMs;
    this.claimedEndGroupId = null;
  }

  /**
   * Exactly-once guard for the end-of-drive navigation (Req 7.9, 19.4).
   *
   * Two independent paths can navigate to /convoy-end when a convoy ends:
   *  - MapScreen's `group:ended` socket handler (every member — the server
   *    broadcasts to the whole room, including the Admin's own socket), and
   *  - ConvoyScreen's Admin end-convoy flow, when the POST /groups/:id/end
   *    response resolves.
   * The socket broadcast is emitted while the POST is still in flight, so for
   * the Admin both paths fire in an arbitrary order and used to double-push
   * the end screen. Both paths must call this before navigating: the first
   * caller gets `true` and navigates; everyone else gets `false` and skips.
   *
   * The claim is keyed by groupId — a group ends exactly once, so a new group
   * re-arms automatically (startSession() also clears it). Keying it, rather
   * than a plain boolean re-armed only by startSession(), matters for an Admin
   * who runs convoys entirely from the convoy tab: MapScreen may never mount,
   * so startSession() may never run between two convoys, and a boolean would
   * stay consumed and silently swallow the second convoy's end screen.
   */
  claimEndNavigation(groupId: string): boolean {
    if (this.claimedEndGroupId === groupId) return false;
    this.claimedEndGroupId = groupId;
    return true;
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
   * Non-destructive snapshot of the current session's stats — lets callers
   * (e.g. the post-drive summary screen) read the route trace / top speed
   * synchronously, without waiting on the server round-trip that
   * finishSession() performs, and without resetting the buffered points.
   */
  peekStats(): DriveStats | null {
    return computeDriveStats(this.points);
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
      id: `drive-offline-${this.sessionStartMs}-${Math.random().toString(36).slice(2, 7)}`,
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
        const record = await params.api.postDrive({
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
        // Confirmed persisted server-side — drop the SQLite copy so SyncService's
        // next drain doesn't re-POST it as a duplicate. Best-effort: a clear
        // failure only risks one later duplicate, never losing the drive, so it
        // must not turn a successful upload into a returned null.
        await params.offlineCache.clearDrives([offlineDrive.id]).catch(() => {});
        return record;
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

// ---------------------------------------------------------------------------
// /convoy-end navigation params — shared by every path that opens the screen
// ---------------------------------------------------------------------------

/**
 * Builds the expo-router params for the /convoy-end summary screen from the
 * server-reported group stats plus the locally-recorded drive stats
 * (peekStats()). Used by BOTH end-of-convoy navigation paths (MapScreen's
 * `group:ended` handler and ConvoyScreen's Admin end flow) so whichever one
 * wins the claimEndNavigation() race, the screen receives identically rich
 * params: top speed and route trace only exist locally, while duration /
 * distance / member count prefer the server's group-wide numbers with the
 * local recording as a fallback (some `group:ended` emits — e.g. auto-end on
 * account deletion — carry no stats at all).
 */
export function buildConvoyEndParams(input: {
  groupName: string | null | undefined;
  memberCount: number | null | undefined;
  durationS: number | null | undefined;
  distanceM: number | null | undefined;
  localStats: DriveStats | null;
}): Record<string, string> {
  const { localStats } = input;
  const durationS = input.durationS != null && input.durationS > 0
    ? input.durationS
    : localStats?.durationS ?? 0;
  const distanceM = input.distanceM != null && input.distanceM > 0
    ? input.distanceM
    : localStats?.distanceM ?? 0;

  return {
    groupName: input.groupName || 'Convoy',
    memberCount: String(input.memberCount ?? 1),
    durationMinutes: String(Math.round(durationS / 60)),
    distanceM: String(distanceM),
    ...(localStats?.topSpeedKph != null
      ? { topSpeedKmh: String(Math.round(localStats.topSpeedKph)) }
      : {}),
    ...(localStats && localStats.routeTrace.coordinates.length > 1
      ? { routeTrace: JSON.stringify(localStats.routeTrace) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared app-wide instance
// ---------------------------------------------------------------------------

/**
 * The app-wide drive session. MapScreen feeds it GPS fixes and starts/finishes
 * the recording; ConvoyScreen's Admin end-convoy flow reads the same instance
 * (peekStats / claimEndNavigation) so both end-of-drive navigation paths agree
 * on one source of truth for "has the end screen already been shown?" and on
 * the locally-recorded stats behind it.
 */
export const driveService = new DriveService();

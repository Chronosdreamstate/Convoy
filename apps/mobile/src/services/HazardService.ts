/**
 * HazardService — submit, confirm, dismiss; queue offline when disconnected.
 * Requirements: 11.1–11.8, 31.1–31.3
 */

import { OfflineCacheService, OfflineHazard } from './OfflineCacheService';
import { offlineQueue, isOfflineError } from './OfflineQueueService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const HAZARD_TYPES = [
  'pothole', 'accident', 'roadwork', 'debris',
  'animal', 'speed_trap', 'ice', 'flood', 'other',
] as const;

export type HazardType = (typeof HAZARD_TYPES)[number];

export interface HazardReport {
  id: string;
  type: HazardType;
  lat: number;
  lng: number;
  status: 'active' | 'expired' | 'dismissed';
  expiresAt: string;
  confirmationCount: number;
  dismissalCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface IHazardApiClient {
  createHazard(type: HazardType, lat: number, lng: number): Promise<HazardReport>;
  confirmHazard(id: string): Promise<void>;
  dismissHazard(id: string): Promise<void>;
}

/** Minimal slice of OfflineQueueService used for vote replay (injectable for tests). */
export interface IHazardVoteQueue {
  enqueue(request: {
    method: 'POST';
    url: string;
    body: unknown;
    headers: Record<string, string>;
    dedupeKey?: string;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// HazardService
// ---------------------------------------------------------------------------

export class HazardService {
  constructor(
    private readonly api: IHazardApiClient,
    private readonly offlineCache: Pick<OfflineCacheService, 'saveOfflineHazard'>,
    private readonly isOnline: () => boolean,
    private readonly nowMs: () => number = () => Date.now(),
    // Votes replay through the general-purpose request queue (NOT the SQLite
    // hazard cache, which only holds hazard *reports* that SyncService bulk-posts).
    private readonly voteQueue: IHazardVoteQueue = offlineQueue,
  ) {}

  /**
   * Reports a new hazard.
   * If offline, queues in SQLite and returns null (will sync later).
   */
  async report(type: HazardType, lat: number, lng: number): Promise<HazardReport | null> {
    if (!this.isOnline()) {
      const offlineHazard: OfflineHazard = {
        // Use nowMs + random suffix to avoid collision when two reports land in same ms
        id: `offline-${this.nowMs()}-${Math.random().toString(36).slice(2, 7)}`,
        lat,
        lng,
        type,
        createdAt: this.nowMs(),
      };
      await this.offlineCache.saveOfflineHazard(offlineHazard);
      return null;
    }
    try {
      return await this.api.createHazard(type, lat, lng);
    } catch (err) {
      // Network failure while technically online — queue for later sync
      const offlineHazard: OfflineHazard = {
        id: `offline-${this.nowMs()}-${Math.random().toString(36).slice(2, 7)}`,
        lat,
        lng,
        type,
        createdAt: this.nowMs(),
      };
      await this.offlineCache.saveOfflineHazard(offlineHazard);
      return null;
    }
  }

  /** Confirms an existing hazard report (resets expiry + increments count). */
  async confirm(id: string): Promise<void> {
    if (!this.isOnline()) {
      await this.enqueueVote(id, 'confirm');
      return;
    }
    try {
      await this.api.confirmHazard(id);
    } catch (err) {
      // Offline-shaped failure (no HTTP response): queue for replay on
      // reconnect. Server rejections (4xx/5xx) stay fire-and-forget —
      // replaying wouldn't change the outcome.
      if (isOfflineError(err)) await this.enqueueVote(id, 'confirm');
    }
  }

  /** Votes to dismiss an existing hazard report. */
  async dismiss(id: string): Promise<void> {
    if (!this.isOnline()) {
      await this.enqueueVote(id, 'dismiss');
      return;
    }
    try {
      await this.api.dismissHazard(id);
    } catch (err) {
      if (isOfflineError(err)) await this.enqueueVote(id, 'dismiss');
    }
  }

  /**
   * Queue a confirm/dismiss vote for replay. dedupeKey is per-hazard so a
   * confirm followed by a dismiss (or repeated taps) while offline replays
   * only the LAST vote — last-write-wins, matching the camera-vote pattern.
   * Endpoints mirror MapScreen's IHazardApiClient implementation. A vote on a
   * hazard that expired before reconnect replays as a 4xx and is dropped by
   * the queue — harmless.
   */
  private async enqueueVote(id: string, vote: 'confirm' | 'dismiss'): Promise<void> {
    // Locally-created offline hazards have no server id yet; their report is
    // still waiting in the SQLite queue, so a vote URL would 404 forever.
    if (id.startsWith('offline-')) return;
    await this.voteQueue.enqueue({
      method: 'POST',
      url: `/api/v1/hazards/${id}/${vote}`,
      body: {},
      headers: {},
      dedupeKey: `hazard-vote:${id}`,
    });
  }
}

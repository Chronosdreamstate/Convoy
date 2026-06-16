/**
 * HazardService — submit, confirm, dismiss; queue offline when disconnected.
 * Requirements: 11.1–11.8, 31.1–31.3
 */

import { OfflineCacheService, OfflineHazard } from './OfflineCacheService';

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

// ---------------------------------------------------------------------------
// HazardService
// ---------------------------------------------------------------------------

export class HazardService {
  constructor(
    private readonly api: IHazardApiClient,
    private readonly offlineCache: Pick<OfflineCacheService, 'saveOfflineHazard'>,
    private readonly isOnline: () => boolean,
    private readonly nowMs: () => number = () => Date.now(),
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
    try {
      await this.api.confirmHazard(id);
    } catch {
      // Confirmation votes are best-effort; no offline queue for votes
    }
  }

  /** Votes to dismiss an existing hazard report. */
  async dismiss(id: string): Promise<void> {
    try {
      await this.api.dismissHazard(id);
    } catch {
      // Dismissal votes are best-effort; no offline queue for votes
    }
  }
}

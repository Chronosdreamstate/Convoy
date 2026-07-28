/**
 * SyncService — drains the SQLite offline queue on reconnect.
 * Requirements: 11.10, 14.4, 19.7
 */

import { IOfflineDB, OfflineHazard, OfflineDrive } from './OfflineCacheService';
import { runExclusiveHazardDrain } from './hazardSyncGuard';

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface INetInfoProvider {
  /** Returns an unsubscribe function. */
  subscribe(callback: (isConnected: boolean) => void): () => void;
}

export interface ISyncApiClient {
  postBulkHazards(hazards: OfflineHazard[]): Promise<void>;
  postDrive(drive: OfflineDrive): Promise<void>;
}

/**
 * True when the error is a client error the server will reject on every retry
 * (4xx validation failures). Excludes statuses that can succeed later:
 * 401 (token refresh), 408 (timeout), 429 (rate limit).
 * Network errors / 5xx have no `response.status` in axios-shaped errors or are
 * >= 500 — both classify as transient.
 */
export function isPermanentApiError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 408 &&
    status !== 429
  );
}

// ---------------------------------------------------------------------------
// SyncService
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

export class SyncService {
  private unsubscribe: (() => void) | null = null;
  private syncing = false;

  constructor(
    private readonly db: IOfflineDB,
    private readonly api: ISyncApiClient,
    private readonly netInfo: INetInfoProvider,
    private readonly onSyncComplete?: () => void,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly isPermanentError: (err: unknown) => boolean = isPermanentApiError,
  ) {}

  /** Begin watching for connectivity changes. */
  start(): void {
    this.unsubscribe = this.netInfo.subscribe((isConnected) => {
      if (isConnected && !this.syncing) void this.sync();
    });
  }

  /** Stop watching. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Drain all pending queues. Can be called directly (e.g. on app foreground). */
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    // Hazards and drives are independent queues — a failure in one (e.g. hazard API
    // down after retries) must not prevent the other from being attempted.
    let firstError: unknown;
    try {
      try {
        await this.syncHazards();
      } catch (err) {
        firstError = err;
      }
      try {
        await this.syncDrives();
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
      if (firstError !== undefined) throw firstError;
      this.onSyncComplete?.();
    } finally {
      this.syncing = false;
    }
  }

  /**
   * The bulk endpoint is transactional (all-or-nothing), so a 2xx means every
   * hazard in the batch was inserted and it is safe to clear them all (Req 11.10).
   * If the server permanently rejects the batch (4xx validation error), one bad
   * queued item would otherwise poison the entire queue forever — so we fall back
   * to posting items one at a time, dropping only the individually-rejected ones
   * and keeping transient failures queued for the next sync.
   */
  private async syncHazards(): Promise<void> {
    // Shared guard: MapScreen.flushOfflineHazards drains the same queue on map
    // mount / socket reconnect. Without this, a reconnect that fires both read
    // the full pending batch before either cleared it and double-POSTed it all.
    await runExclusiveHazardDrain(() => this.drainHazards());
  }

  private async drainHazards(): Promise<void> {
    const hazards = await this.db.getPendingHazards();
    if (hazards.length === 0) return;
    try {
      await this.retryWithBackoff(() => this.api.postBulkHazards(hazards), MAX_RETRIES);
      await this.db.clearHazards(hazards.map((h) => h.id));
      return;
    } catch (err) {
      if (!this.isPermanentError(err)) throw err;
      if (hazards.length === 1) {
        // Single poison item — the server will never accept it; drop it so the
        // queue doesn't stall forever.
        console.warn('[SyncService] Dropping hazard permanently rejected by server:', hazards[0].id, err);
        await this.db.clearHazards([hazards[0].id]);
        return;
      }
    }

    // Batch permanently rejected — isolate the poison item(s) per-item.
    let firstTransientError: unknown;
    for (const hazard of hazards) {
      try {
        await this.retryWithBackoff(() => this.api.postBulkHazards([hazard]), MAX_RETRIES);
        await this.db.clearHazards([hazard.id]);
      } catch (itemErr) {
        if (this.isPermanentError(itemErr)) {
          console.warn('[SyncService] Dropping hazard permanently rejected by server:', hazard.id, itemErr);
          await this.db.clearHazards([hazard.id]);
        } else if (firstTransientError === undefined) {
          firstTransientError = itemErr;
        }
      }
    }
    if (firstTransientError !== undefined) throw firstTransientError;
  }

  private async syncDrives(): Promise<void> {
    const drives = await this.db.getPendingDrives();
    if (drives.length === 0) return;
    let firstError: unknown;
    for (const drive of drives) {
      try {
        await this.retryWithBackoff(() => this.api.postDrive(drive), MAX_RETRIES);
        await this.db.clearDrives([drive.id]);
      } catch (err) {
        firstError = err;
      }
    }
    if (firstError) throw firstError;
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        // A permanent (4xx validation) error will fail identically on every
        // attempt — retrying just wastes battery and delays the caller.
        if (this.isPermanentError(err)) throw err;
        if (attempt < maxRetries - 1) {
          await this.sleep(1000 * Math.pow(2, attempt));
        }
      }
    }
    throw lastError;
  }
}

/**
 * SyncService — drains the SQLite offline queue on reconnect.
 * Requirements: 11.10, 14.4, 19.7
 */

import { IOfflineDB, OfflineHazard, OfflineDrive } from './OfflineCacheService';

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
    try {
      await this.syncHazards();
      await this.syncDrives();
      this.onSyncComplete?.();
    } finally {
      this.syncing = false;
    }
  }

  private async syncHazards(): Promise<void> {
    const hazards = await this.db.getPendingHazards();
    if (hazards.length === 0) return;
    await this.retryWithBackoff(() => this.api.postBulkHazards(hazards), MAX_RETRIES);
    await this.db.clearHazards(hazards.map((h) => h.id));
  }

  private async syncDrives(): Promise<void> {
    const drives = await this.db.getPendingDrives();
    if (drives.length === 0) return;
    for (const drive of drives) {
      await this.retryWithBackoff(() => this.api.postDrive(drive), MAX_RETRIES);
    }
    await this.db.clearDrives(drives.map((d) => d.id));
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries - 1) {
          await this.sleep(1000 * Math.pow(2, attempt));
        }
      }
    }
    throw lastError;
  }
}

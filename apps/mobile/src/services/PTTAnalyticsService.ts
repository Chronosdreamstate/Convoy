/**
 * PTTAnalyticsService — in-memory PTT analytics for an active group session.
 * Tracks per-user transmit count and total talk time; resets at session start.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PttStat {
  userId: string;
  callsign: string;
  transmitCount: number;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class PTTAnalyticsService {
  private stats: PttStat[] = [];

  /**
   * Upsert a completed PTT transmission into the stats array.
   * If the user already has an entry, increments their counters; otherwise adds a new one.
   */
  recordTransmit(userId: string, callsign: string, durationMs: number): void {
    const existing = this.stats.find((s) => s.userId === userId);
    if (existing) {
      existing.transmitCount += 1;
      existing.totalDurationMs += durationMs;
      // Keep callsign up-to-date in case it changed
      existing.callsign = callsign;
    } else {
      this.stats.push({ userId, callsign, transmitCount: 1, totalDurationMs: durationMs });
    }
  }

  /**
   * Returns a copy of the stats array sorted by totalDurationMs descending.
   */
  getLeaderboard(): PttStat[] {
    return [...this.stats].sort((a, b) => b.totalDurationMs - a.totalDurationMs);
  }

  /**
   * Clears all accumulated stats. Call this when a new session starts.
   */
  reset(): void {
    this.stats = [];
  }

  /**
   * Formats a duration in milliseconds as a human-readable string, e.g. "1m 23s".
   * Sub-minute durations render as just "45s".
   */
  formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const pttAnalytics = new PTTAnalyticsService();

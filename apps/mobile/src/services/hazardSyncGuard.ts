/**
 * Serializes the two independent offline-hazard drain paths:
 *   - MapScreen.flushOfflineHazards (on map mount and socket reconnect)
 *   - SyncService.syncHazards (on connectivity recovery / foreground)
 *
 * Both read the same pending-hazards table, bulk-POST, then clear. On reconnect
 * they could fire together, each reading the full pending list before either
 * cleared it — so every queued hazard was POSTed twice (and POST /hazards/bulk
 * has no idempotency key). This shared in-flight flag lets the second caller
 * skip while the first is draining; the skipped work is covered by the drain
 * already running (or the next trigger). Kept in its own dependency-free module
 * so SyncService can import it without pulling in the native SQLite layer.
 */
let inFlight = false;

export async function runExclusiveHazardDrain(drain: () => Promise<void>): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await drain();
  } finally {
    inFlight = false;
  }
}

/** Test-only: reset the guard between cases. */
export function __resetHazardDrainGuard(): void {
  inFlight = false;
}

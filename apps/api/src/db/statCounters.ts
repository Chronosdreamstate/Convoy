import { Pool } from 'pg';

/**
 * Increments (or creates) a per-user named stat counter used to back
 * achievement progress (see GET /users/me/achievements in users.routes.ts).
 *
 * Kept as a single generic key/count table (user_stat_counters, migration
 * 029) rather than a dedicated column/table per stat — cheap to add new
 * counters without another migration.
 */
export async function incrementStatCounter(
  db: Pool,
  userId: string,
  statKey: string,
  by = 1,
): Promise<void> {
  if (by <= 0) return;
  await db.query(
    `INSERT INTO user_stat_counters (user_id, stat_key, count, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, stat_key)
     DO UPDATE SET count = user_stat_counters.count + EXCLUDED.count, updated_at = now()`,
    [userId, statKey, by],
  );
}

/** Reads a single named stat counter for a user, defaulting to 0. */
export async function getStatCounter(db: Pool, userId: string, statKey: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count FROM user_stat_counters WHERE user_id = $1 AND stat_key = $2`,
    [userId, statKey],
  );
  return result.rows[0]?.count ?? 0;
}

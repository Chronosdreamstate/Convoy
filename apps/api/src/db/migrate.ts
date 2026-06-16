/**
 * Simple migration runner using node-postgres.
 *
 * Migrations are plain SQL files in src/db/migrations/ named NNN_description.sql.
 * Applied migrations are tracked in a `schema_migrations` table.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';
import { env } from '../config/env';

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

interface Migration {
  version: string;
  name: string;
  filepath: string;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return new Set(result.rows.map((r) => r.version));
}

function loadMigrations(): Migration[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`[migrate] Migrations directory not found: ${MIGRATIONS_DIR}`);
    return [];
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        throw new Error(`Invalid migration filename: ${filename}. Expected NNN_description.sql`);
      }
      return {
        version: match[1],
        name: match[2],
        filepath: path.join(MIGRATIONS_DIR, filename),
      };
    });
}

async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const migrations = loadMigrations();

    const pending = migrations.filter((m) => !applied.has(m.version));

    if (pending.length === 0) {
      console.log('[migrate] No pending migrations.');
      return;
    }

    console.log(`[migrate] Applying ${pending.length} migration(s)...`);

    for (const migration of pending) {
      const sql = fs.readFileSync(migration.filepath, 'utf-8');
      console.log(`[migrate] Applying ${migration.version}_${migration.name}.sql ...`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        );
        await client.query('COMMIT');
        console.log(`[migrate] ✓ Applied ${migration.version}_${migration.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ✗ Failed ${migration.version}_${migration.name}:`, err);
        throw err;
      }
    }

    console.log('[migrate] All migrations applied successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

// Run when executed directly
runMigrations().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});

export { runMigrations };

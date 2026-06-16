import { Pool, PoolConfig } from 'pg';
import { env } from '../config/env';

let _pool: Pool | null = null;

export function createPool(config?: PoolConfig): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });
}

export function getPool(): Pool {
  if (!_pool) {
    _pool = createPool();
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

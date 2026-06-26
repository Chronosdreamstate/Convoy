/**
 * Property tests for ScenicRouteService.
 *
 * Property 113: setScenicMode / getScenicMode round-trip
 *   For any boolean value, reading back after writing always returns that value.
 *   Validates: Requirements 22.5
 *
 * Property 114: Only the exact string '1' maps to true
 *   Any storage value other than '1' — including null, '0', '', 'true', '1 ' —
 *   is treated as disabled (false).
 *   Validates: Requirements 22.5
 *
 * Property 115: Default state (empty storage) is false
 *   getScenicMode returns false when storage has never been written.
 *   Validates: Requirements 22.5
 */

import fc from 'fast-check';
import { ScenicRouteService } from './ScenicRouteService';
import type { IPinStorage } from './PinDropService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function buildStorage(initial: Record<string, string> = {}): IPinStorage {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: jest.fn(async (key: string) => store[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { store[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete store[key]; }),
  };
}

// ---------------------------------------------------------------------------
// Property 113: setScenicMode / getScenicMode round-trip
// ---------------------------------------------------------------------------

describe('Property 113: setScenicMode / getScenicMode round-trip', () => {
  it('reading back after writing returns the same boolean for any value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enabled) => {
          const storage = buildStorage();
          const svc = new ScenicRouteService(storage);
          await svc.setScenicMode(enabled);
          const result = await svc.getScenicMode();
          expect(result).toBe(enabled);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('last write wins when setScenicMode is called multiple times', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        async (writes) => {
          const storage = buildStorage();
          const svc = new ScenicRouteService(storage);
          for (const v of writes) {
            await svc.setScenicMode(v);
          }
          const result = await svc.getScenicMode();
          expect(result).toBe(writes[writes.length - 1]);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 114: Only '1' maps to true — any other raw value is false
// ---------------------------------------------------------------------------

describe('Property 114: Only the exact string "1" in storage maps to true', () => {
  it('returns false for any non-"1" string in storage', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => s !== '1'),
        async (rawValue) => {
          const storage = buildStorage({ 'convoy:scenic_route_enabled': rawValue });
          const svc = new ScenicRouteService(storage);
          const result = await svc.getScenicMode();
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns true for exactly "1" in storage', async () => {
    const storage = buildStorage({ 'convoy:scenic_route_enabled': '1' });
    const svc = new ScenicRouteService(storage);
    expect(await svc.getScenicMode()).toBe(true);
  });

  it('returns false for common near-miss values: "0", "true", "false", " 1", "1 "', async () => {
    const nearMisses = ['0', 'true', 'false', ' 1', '1 ', 'True', 'TRUE', 'yes', ''];
    for (const raw of nearMisses) {
      const storage = buildStorage({ 'convoy:scenic_route_enabled': raw });
      const svc = new ScenicRouteService(storage);
      expect(await svc.getScenicMode()).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 115: Default state (empty storage) is false
// ---------------------------------------------------------------------------

describe('Property 115: Default state is false when storage is empty', () => {
  it('getScenicMode returns false without any prior setScenicMode call', async () => {
    const storage = buildStorage(); // empty
    const svc = new ScenicRouteService(storage);
    expect(await svc.getScenicMode()).toBe(false);
  });

  it('storage.getItem is called with the correct key regardless of enabled value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enabled) => {
          const storage = buildStorage();
          const svc = new ScenicRouteService(storage);
          await svc.setScenicMode(enabled);
          await svc.getScenicMode();
          expect(storage.setItem).toHaveBeenCalledWith('convoy:scenic_route_enabled', enabled ? '1' : '0');
          expect(storage.getItem).toHaveBeenCalledWith('convoy:scenic_route_enabled');
        },
      ),
      { numRuns: 30 },
    );
  });
});

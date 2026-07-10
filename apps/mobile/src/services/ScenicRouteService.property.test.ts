/**
 * Property tests for ScenicRouteService (settings-store facade).
 *
 * Property 113: setScenicMode / getScenicMode round-trip
 *   For any boolean value, reading back after writing always returns that value.
 *   Validates: Requirements 22.5
 *
 * Property 114: The service and the settings store never diverge
 *   Writing via the service is visible in useSettingsStore and vice versa —
 *   there is exactly one source of truth (REVIEW_FINDINGS #21).
 *   Validates: Requirements 22.5
 *
 * Property 115: Default state is false
 *   getScenicMode returns false when the preference has never been set.
 *   Validates: Requirements 22.5
 *
 * Property 116: The preference is included in the persisted (cold-start) state
 *   The store's persist partialize output always contains the current
 *   scenicRouting value, so it survives app restarts.
 *   Validates: Requirements 22.5
 */

import fc from 'fast-check';
import { ScenicRouteService } from './ScenicRouteService';
import { useSettingsStore } from '../stores/settingsStore';

beforeEach(() => {
  // Reset the shared store to its default between tests
  useSettingsStore.setState({ scenicRouting: false });
});

// ---------------------------------------------------------------------------
// Property 113: setScenicMode / getScenicMode round-trip
// ---------------------------------------------------------------------------

describe('Property 113: setScenicMode / getScenicMode round-trip', () => {
  it('reading back after writing returns the same boolean for any value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enabled) => {
          const svc = new ScenicRouteService();
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
          const svc = new ScenicRouteService();
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
// Property 114: Service and settings store never diverge (single source of truth)
// ---------------------------------------------------------------------------

describe('Property 114: ScenicRouteService and useSettingsStore never diverge', () => {
  it('writes via the service are visible in the store', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enabled) => {
          const svc = new ScenicRouteService();
          await svc.setScenicMode(enabled);
          expect(useSettingsStore.getState().scenicRouting).toBe(enabled);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('writes via the store (e.g. SettingsScreen) are visible through the service', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enabled) => {
          useSettingsStore.getState().setSettings({ scenicRouting: enabled });
          const svc = new ScenicRouteService();
          expect(await svc.getScenicMode()).toBe(enabled);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('two service instances always agree (shared store state)', async () => {
    const svc1 = new ScenicRouteService();
    const svc2 = new ScenicRouteService();
    await svc1.setScenicMode(true);
    expect(await svc2.getScenicMode()).toBe(true);
    await svc2.setScenicMode(false);
    expect(await svc1.getScenicMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 115: Default state is false
// ---------------------------------------------------------------------------

describe('Property 115: Default state is false when the preference was never set', () => {
  it('getScenicMode returns false without any prior setScenicMode call', async () => {
    const svc = new ScenicRouteService();
    expect(await svc.getScenicMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 116: Preference is part of the persisted cold-start state
// ---------------------------------------------------------------------------

describe('Property 116: scenicRouting is included in the persisted settings state', () => {
  it('the persist partialize output contains the current scenicRouting value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enabled) => {
          const svc = new ScenicRouteService();
          await svc.setScenicMode(enabled);
          const options = useSettingsStore.persist.getOptions();
          const partialize = options.partialize!;
          const persisted = partialize(useSettingsStore.getState()) as { scenicRouting: boolean };
          expect(persisted.scenicRouting).toBe(enabled);
        },
      ),
      { numRuns: 30 },
    );
  });
});

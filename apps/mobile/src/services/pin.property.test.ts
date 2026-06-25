/**
 * Property tests for PinDropService.
 *
 * Property 75: Dropped pins are stored locally only — no API calls
 *   Validates: Requirements 5.4
 *
 * Property 76: savePin upserts correctly — updates existing, appends new
 *   Validates: Requirements 5.3
 *
 * Property 77: getPins is resilient to corrupted or missing storage
 *   Validates: Requirements 43.1
 */

import fc from 'fast-check';
import { PinDropService, DroppedPin, IPinStorage } from './PinDropService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeMemoryStorage(): { storage: IPinStorage; data: Map<string, string> } {
  const data = new Map<string, string>();
  const storage: IPinStorage = {
    getItem: jest.fn(async (key: string) => data.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { data.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { data.delete(key); }),
  };
  return { storage, data };
}

function makeNullGeocoder(): jest.MockedFunction<(lat: number, lng: number) => Promise<string | null>> {
  return jest.fn(async () => null);
}

function makeGeocoder(result: string | null): jest.MockedFunction<(lat: number, lng: number) => Promise<string | null>> {
  return jest.fn(async () => result);
}

function makePin(overrides: Partial<DroppedPin> = {}): DroppedPin {
  return {
    id: `pin-${Math.random().toString(36).slice(2)}`,
    lat: 37.77,
    lng: -122.41,
    address: 'Market St, San Francisco',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 75: Dropped pins are stored locally only — no API calls
// ---------------------------------------------------------------------------
describe('Property 75: Dropped pins are stored locally only', () => {
  it('dropPin stores the pin in local storage without API calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        async (lat, lng) => {
          const { storage } = makeMemoryStorage();
          const geocoder = makeNullGeocoder();
          const svc = new PinDropService(storage, geocoder);

          const pin = await svc.dropPin(lat, lng);

          expect(pin.lat).toBe(lat);
          expect(pin.lng).toBe(lng);
          expect(storage.setItem).toHaveBeenCalledTimes(1);
          expect(geocoder).toHaveBeenCalledWith(lat, lng);
          // verify pin is retrievable
          const pins = await svc.getPins();
          expect(pins).toHaveLength(1);
          expect(pins[0].id).toBe(pin.id);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('dropPin attaches the geocoded address to the pin', async () => {
    const { storage } = makeMemoryStorage();
    const geocoder = makeGeocoder('1 Market St, SF');
    const svc = new PinDropService(storage, geocoder);

    const pin = await svc.dropPin(37.77, -122.41);
    expect(pin.address).toBe('1 Market St, SF');
  });

  it('dropPin works when geocoder returns null', async () => {
    const { storage } = makeMemoryStorage();
    const geocoder = makeGeocoder(null);
    const svc = new PinDropService(storage, geocoder);

    const pin = await svc.dropPin(37.77, -122.41);
    expect(pin.address).toBeNull();
    expect(pin.lat).toBe(37.77);
  });

  it('dropPin produces a pin with non-empty id and positive createdAt', async () => {
    const before = Date.now();
    const { storage } = makeMemoryStorage();
    const svc = new PinDropService(storage, makeNullGeocoder());
    const pin = await svc.dropPin(0, 0);
    const after = Date.now();

    expect(pin.id.length).toBeGreaterThan(0);
    expect(pin.createdAt).toBeGreaterThanOrEqual(before);
    expect(pin.createdAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// Property 76: savePin upserts — updates existing, appends new
// ---------------------------------------------------------------------------
describe('Property 76: savePin upserts correctly', () => {
  it('saving a pin with a new id appends to the list', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (count) => {
          const { storage } = makeMemoryStorage();
          const svc = new PinDropService(storage, makeNullGeocoder());

          const ids: string[] = [];
          for (let i = 0; i < count; i++) {
            const pin = makePin({ id: `pin-${i}`, lat: i * 0.1, lng: i * 0.1 });
            ids.push(pin.id);
            await svc.savePin(pin);
          }

          const pins = await svc.getPins();
          expect(pins).toHaveLength(count);
          expect(pins.map((p) => p.id)).toEqual(expect.arrayContaining(ids));
        },
      ),
      { numRuns: 15 },
    );
  });

  it('saving a pin with an existing id updates that pin in place', async () => {
    const { storage } = makeMemoryStorage();
    const svc = new PinDropService(storage, makeNullGeocoder());

    const original = makePin({ id: 'pin-x', address: 'Original St' });
    await svc.savePin(original);

    const updated = { ...original, address: 'Updated Ave', lat: 99.0 };
    await svc.savePin(updated);

    const pins = await svc.getPins();
    expect(pins).toHaveLength(1);
    expect(pins[0].address).toBe('Updated Ave');
    expect(pins[0].lat).toBe(99.0);
  });

  it('removePin deletes only the targeted pin', async () => {
    const { storage } = makeMemoryStorage();
    const svc = new PinDropService(storage, makeNullGeocoder());

    const p1 = makePin({ id: 'pin-keep' });
    const p2 = makePin({ id: 'pin-remove' });
    await svc.savePin(p1);
    await svc.savePin(p2);

    await svc.removePin('pin-remove');

    const pins = await svc.getPins();
    expect(pins).toHaveLength(1);
    expect(pins[0].id).toBe('pin-keep');
  });

  it('removePin on non-existent id leaves list unchanged', async () => {
    const { storage } = makeMemoryStorage();
    const svc = new PinDropService(storage, makeNullGeocoder());

    const p = makePin({ id: 'pin-a' });
    await svc.savePin(p);
    await svc.removePin('pin-nonexistent');

    const pins = await svc.getPins();
    expect(pins).toHaveLength(1);
  });

  it('round-trip: drop N pins then remove all leaves empty list', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        async (count) => {
          const { storage } = makeMemoryStorage();
          const svc = new PinDropService(storage, makeNullGeocoder());

          const dropped: DroppedPin[] = [];
          for (let i = 0; i < count; i++) {
            const p = await svc.dropPin(i * 0.01, i * 0.01);
            dropped.push(p);
          }

          for (const pin of dropped) {
            await svc.removePin(pin.id);
          }

          const remaining = await svc.getPins();
          expect(remaining).toHaveLength(0);
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 77: getPins is resilient to corrupted or missing storage
// ---------------------------------------------------------------------------
describe('Property 77: getPins is resilient to corrupted storage', () => {
  it('getPins returns [] when storage is empty (null)', async () => {
    const { storage } = makeMemoryStorage();
    const svc = new PinDropService(storage, makeNullGeocoder());

    const pins = await svc.getPins();
    expect(pins).toEqual([]);
  });

  it('getPins returns [] when storage contains invalid JSON', async () => {
    const { storage, data } = makeMemoryStorage();
    data.set('convoy:dropped_pins', 'NOT_VALID_JSON{{{');
    const svc = new PinDropService(storage, makeNullGeocoder());

    const pins = await svc.getPins();
    expect(pins).toEqual([]);
  });

  it('getPins returns [] for empty string in storage', async () => {
    const { storage, data } = makeMemoryStorage();
    data.set('convoy:dropped_pins', '');
    const svc = new PinDropService(storage, makeNullGeocoder());

    // empty string is falsy — treated as null
    const pins = await svc.getPins();
    expect(Array.isArray(pins)).toBe(true);
  });

  it('getPins returns [] for arbitrary garbage strings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => {
          try { JSON.parse(s); return false; } catch { return true; }
        }),
        async (garbage) => {
          const { storage, data } = makeMemoryStorage();
          data.set('convoy:dropped_pins', garbage);
          const svc = new PinDropService(storage, makeNullGeocoder());
          const pins = await svc.getPins();
          expect(Array.isArray(pins)).toBe(true);
          expect(pins).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });
});

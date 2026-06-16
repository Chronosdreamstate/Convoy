/** Stores dropped-map-pins on device only; never transmits to backend (Req 5.4). */

export interface DroppedPin {
  id: string;
  lat: number;
  lng: number;
  address: string | null;
  createdAt: number;
}

/** Minimal storage interface so PinDropService is testable without AsyncStorage. */
export interface IPinStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Reverse-geocoding function type (injectable for testing). */
export type GeocoderFn = (lat: number, lng: number) => Promise<string | null>;

const STORAGE_KEY = 'convoy:dropped_pins';

export class PinDropService {
  constructor(
    private readonly storage: IPinStorage,
    private readonly geocoder: GeocoderFn,
  ) {}

  async getPins(): Promise<DroppedPin[]> {
    const raw = await this.storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw) as DroppedPin[]; } catch { return []; }
  }

  async savePin(pin: DroppedPin): Promise<void> {
    const current = await this.getPins();
    const idx = current.findIndex((p) => p.id === pin.id);
    if (idx >= 0) current[idx] = pin; else current.push(pin);
    // Pins are stored locally; no network call is made here (Property 5)
    await this.storage.setItem(STORAGE_KEY, JSON.stringify(current));
  }

  async removePin(id: string): Promise<void> {
    const pins = (await this.getPins()).filter((p) => p.id !== id);
    await this.storage.setItem(STORAGE_KEY, JSON.stringify(pins));
  }

  /**
   * Drop a new pin at (lat, lng): reverse-geocode the address,
   * persist to local storage, and return the pin.
   * Does NOT transmit to the API.
   */
  async dropPin(lat: number, lng: number): Promise<DroppedPin> {
    const address = await this.geocoder(lat, lng);
    const pin: DroppedPin = {
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      lat,
      lng,
      address,
      createdAt: Date.now(),
    };
    await this.savePin(pin);
    return pin;
  }
}

/** Production geocoder — calls the Mapbox Geocoding API. */
export function makeMapboxGeocoder(token: string): GeocoderFn {
  return async (lat, lng) => {
    try {
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}&types=address,poi`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { features?: { place_name?: string }[] };
      return data.features?.[0]?.place_name ?? null;
    } catch {
      return null;
    }
  };
}

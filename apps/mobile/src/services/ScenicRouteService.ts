/** Persists the scenic-routing preference across sessions (Property 37, Req 22.5). */

import type { IPinStorage } from './PinDropService';

const STORAGE_KEY = 'convoy:scenic_route_enabled';

export class ScenicRouteService {
  constructor(private readonly storage: IPinStorage) {}

  async setScenicMode(enabled: boolean): Promise<void> {
    await this.storage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  }

  async getScenicMode(): Promise<boolean> {
    const raw = await this.storage.getItem(STORAGE_KEY);
    return raw === '1';
  }
}

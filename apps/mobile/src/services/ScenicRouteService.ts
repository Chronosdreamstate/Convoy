/**
 * Scenic-routing preference facade (Req 22.5).
 *
 * The single source of truth is `useSettingsStore.scenicRouting`: it is
 * persisted across cold starts by the store's zustand `persist` middleware
 * (SecureStore-backed) and synced to the server by SettingsScreen. This class
 * previously wrote to its own storage key (`convoy:scenic_route_enabled`),
 * which could diverge from the store (REVIEW_FINDINGS #21) — it is now a thin
 * non-React entry point over the store for code that cannot use hooks.
 */

import { useSettingsStore } from '../stores/settingsStore';

export class ScenicRouteService {
  /** Update the scenic-routing preference. Persistence is handled by the settings store. */
  async setScenicMode(enabled: boolean): Promise<void> {
    useSettingsStore.getState().setSettings({ scenicRouting: enabled });
  }

  /** Read the current scenic-routing preference from the settings store. */
  async getScenicMode(): Promise<boolean> {
    return useSettingsStore.getState().scenicRouting;
  }
}

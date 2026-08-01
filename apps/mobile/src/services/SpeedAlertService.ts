import { apiClient } from './apiClient';
import { offlineQueue, isOfflineError } from './OfflineQueueService';
import { haversineDistanceM } from '../utils/geo';

export interface SpeedCamera {
  id: string;
  lat: number;
  lng: number;
  type: 'fixed' | 'mobile' | 'avg_speed' | 'red_light';
  speedLimitKph?: number;
  direction?: number;
  source: 'community' | 'opendata';
  confirmedAt?: number;
}

const ALERT_RADIUS_M = 500;

class SpeedAlertService {
  private cameras: SpeedCamera[] = [];
  private alertedIds = new Set<string>();
  private onAlert: ((camera: SpeedCamera, distanceM: number) => void) | null = null;

  setAlertCallback(cb: (camera: SpeedCamera, distanceM: number) => void): void {
    this.onAlert = cb;
  }

  async loadCamerasNear(lat: number, lng: number, radiusKm = 10): Promise<void> {
    try {
      const res = await apiClient.get<{ cameras?: SpeedCamera[] }>(
        `/api/v1/speed-cameras?lat=${lat}&lng=${lng}&radius=${radiusKm}`,
      );
      this.cameras = res.data.cameras ?? [];
    } catch { /* use cached cameras */ }
  }

  checkLocation(lat: number, lng: number): void {
    for (const camera of this.cameras) {
      const dist = haversineDistanceM(lat, lng, camera.lat, camera.lng);
      if (dist <= ALERT_RADIUS_M && !this.alertedIds.has(camera.id)) {
        this.alertedIds.add(camera.id);
        this.onAlert?.(camera, Math.round(dist));
        // Auto-clear so the same camera can alert again after passing
        setTimeout(() => this.alertedIds.delete(camera.id), 60_000);
      }
    }
  }

  async reportCamera(lat: number, lng: number, type: SpeedCamera['type']): Promise<void> {
    const body = { lat, lng, type, source: 'community' as const };
    try {
      await apiClient.post('/api/v1/speed-cameras', body);
    } catch (err) {
      // Offline: queue the report for replay on reconnect. Server rejections
      // (4xx/5xx) stay fire-and-forget — replaying wouldn't change them.
      if (isOfflineError(err)) {
        // dedupeKey: POST /speed-cameras is a plain INSERT, so without one a
        // driver who tapped report twice at the same spot (or drove past it on
        // the way back) queued two entries that both replayed into separate
        // map pins. Rounded to ~11m so the same camera reported from slightly
        // different fixes collapses to one queued report.
        const cell = `${lat.toFixed(4)},${lng.toFixed(4)}`;
        await offlineQueue.enqueue({
          method: 'POST',
          url: '/api/v1/speed-cameras',
          body,
          headers: {},
          dedupeKey: `camera-report:${type}:${cell}`,
        });
      }
    }
  }

  async voteOnCamera(id: string, vote: 'confirm' | 'deny'): Promise<void> {
    try {
      await apiClient.post(`/api/v1/speed-cameras/${id}/vote`, { vote });
    } catch (err) {
      if (isOfflineError(err)) {
        // dedupeKey: only the newest vote for a given camera is kept, so
        // confirm-then-deny while offline replays only the deny.
        await offlineQueue.enqueue({
          method: 'POST',
          url: `/api/v1/speed-cameras/${id}/vote`,
          body: { vote },
          headers: {},
          dedupeKey: `camera-vote:${id}`,
        });
      }
    }
  }
}

export const speedAlertService = new SpeedAlertService();

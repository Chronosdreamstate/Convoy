import { apiClient } from './apiClient';
import { offlineQueue } from './OfflineQueueService';
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

/**
 * Axios-shaped "no HTTP response" failure — the device is offline (or the
 * server is unreachable). 4xx/5xx responses are NOT offline: the request got
 * through and queueing a replay would not change the outcome (5xx were
 * already retried with backoff by apiClient's interceptor).
 */
function isOfflineError(err: unknown): boolean {
  return (err as { response?: unknown } | null)?.response === undefined;
}

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
        await offlineQueue.enqueue({ method: 'POST', url: '/api/v1/speed-cameras', body, headers: {} });
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

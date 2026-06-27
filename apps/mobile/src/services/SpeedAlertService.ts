import { apiClient } from './apiClient';

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

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
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
      const dist = distanceM(lat, lng, camera.lat, camera.lng);
      if (dist <= ALERT_RADIUS_M && !this.alertedIds.has(camera.id)) {
        this.alertedIds.add(camera.id);
        this.onAlert?.(camera, Math.round(dist));
        // Auto-clear so the same camera can alert again after passing
        setTimeout(() => this.alertedIds.delete(camera.id), 60_000);
      }
    }
  }

  async reportCamera(lat: number, lng: number, type: SpeedCamera['type']): Promise<void> {
    try {
      await apiClient.post('/api/v1/speed-cameras', { lat, lng, type, source: 'community' });
    } catch { /* fire-and-forget */ }
  }

  async voteOnCamera(id: string, vote: 'confirm' | 'deny'): Promise<void> {
    try {
      await apiClient.post(`/api/v1/speed-cameras/${id}/vote`, { vote });
    } catch { /* fire-and-forget */ }
  }
}

export const speedAlertService = new SpeedAlertService();

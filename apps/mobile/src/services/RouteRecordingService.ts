import AsyncStorage from '@react-native-async-storage/async-storage';

export interface RoutePoint {
  lat: number;
  lng: number;
  timestamp: number;
  speedKph?: number;
}

const RECORDING_KEY = '@convoy/active_route';
const MIN_DISTANCE_M = 20;
const MAX_POINTS = 2000;

function haversineM(a: RoutePoint, b: RoutePoint): number {
  const R = 6371000;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

class RouteRecorder {
  private points: RoutePoint[] = [];
  private driveId: string | null = null;
  private isRecording = false;

  async startRecording(driveId: string): Promise<void> {
    this.driveId = driveId;
    this.points = [];
    this.isRecording = true;
    await AsyncStorage.setItem(RECORDING_KEY, JSON.stringify({ driveId, points: [] })).catch(() => {});
  }

  async addPoint(point: RoutePoint): Promise<void> {
    if (!this.isRecording) return;
    const last = this.points[this.points.length - 1];
    if (last && haversineM(last, point) < MIN_DISTANCE_M) return;
    this.points.push(point);
    if (this.points.length > MAX_POINTS) {
      this.points = this.points.filter((_, i) => i % 2 === 0);
    }
    if (this.points.length % 10 === 0) {
      await AsyncStorage.setItem(RECORDING_KEY, JSON.stringify({ driveId: this.driveId, points: this.points })).catch(() => {});
    }
  }

  async stopRecording(): Promise<RoutePoint[]> {
    this.isRecording = false;
    const points = [...this.points];
    await AsyncStorage.removeItem(RECORDING_KEY).catch(() => {});
    this.points = [];
    this.driveId = null;
    return points;
  }

  async resumeIfCrashed(): Promise<{ driveId: string; points: RoutePoint[] } | null> {
    try {
      const saved = await AsyncStorage.getItem(RECORDING_KEY);
      if (!saved) return null;
      const data = JSON.parse(saved);
      this.driveId = data.driveId;
      this.points = data.points ?? [];
      this.isRecording = true;
      return data;
    } catch {
      return null;
    }
  }

  getDistanceKm(): number {
    let total = 0;
    for (let i = 1; i < this.points.length; i++) {
      total += haversineM(this.points[i - 1], this.points[i]);
    }
    return total / 1000;
  }

  getRoutePolyline(): { lat: number; lng: number }[] {
    return this.points.map((p) => ({ lat: p.lat, lng: p.lng }));
  }

  toGeoJSON(): { type: 'LineString'; coordinates: [number, number][] } {
    return {
      type: 'LineString',
      coordinates: this.points.map((p) => [p.lng, p.lat]),
    };
  }

  get pointCount(): number {
    return this.points.length;
  }

  get recording(): boolean {
    return this.isRecording;
  }
}

export const routeRecorder = new RouteRecorder();

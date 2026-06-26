/**
 * RallyService — broadcast/cancel rally points and SOS pins.
 * Requirements: 20.1–20.6, 25.1–25.7
 */

import { apiClient } from './apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SosType = 'breakdown' | 'accident' | 'medical' | 'fuel' | 'general';

export type RallyPointType = 'waypoint' | 'meetup' | 'fuel' | 'rest' | 'photo';

export const SOS_EMOJI: Record<SosType, string> = {
  breakdown: '🔧',
  accident:  '🚨',
  medical:   '🏥',
  fuel:      '⛽',
  general:   '🆘',
};

export const RALLY_EMOJI: Record<RallyPointType, string> = {
  waypoint: '📍',
  meetup:   '🤝',
  fuel:     '⛽',
  rest:     '☕',
  photo:    '📸',
};

export interface RallyPoint {
  id: string;
  broadcasterId: string;
  lat: number;
  lng: number;
  address: string | null;
  isActive: boolean;
  type: RallyPointType;
  createdAt: string;
}

export interface SosPin {
  id: string;
  userId: string;
  groupId: string | null;
  lat: number;
  lng: number;
  type: SosType;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Haversine distance in metres between two lat/lng points. */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Returns the nearest active rally point to (lat, lng), or null if none. */
export function getNearestRallyPoint(
  lat: number,
  lng: number,
  points: RallyPoint[],
): RallyPoint | null {
  const active = points.filter((p) => p.isActive);
  if (active.length === 0) return null;
  return active.reduce((nearest, p) =>
    haversineM(lat, lng, p.lat, p.lng) < haversineM(lat, lng, nearest.lat, nearest.lng)
      ? p
      : nearest,
  );
}

const SOS_MESSAGES: Record<SosType, (name: string) => string> = {
  breakdown: (n) => `${n} has a breakdown and needs assistance`,
  accident:  (n) => `${n} has been in an accident — please check in`,
  medical:   (n) => `${n} has a medical emergency`,
  fuel:      (n) => `${n} is out of fuel and needs help`,
  general:   (n) => `${n} needs assistance`,
};

/** Human-readable SOS alert message. */
export function formatSosMessage(type: SosType, memberName: string): string {
  return SOS_MESSAGES[type]?.(memberName) ?? SOS_MESSAGES.general(memberName);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class RallyService {
  /** Broadcast a rally point to the active group (Req 20.1). */
  async broadcastRally(
    groupId: string,
    lat: number,
    lng: number,
    type: RallyPointType = 'waypoint',
  ): Promise<RallyPoint> {
    const res = await apiClient.post<RallyPoint>(`/api/v1/groups/${groupId}/rally`, { lat, lng, type });
    return res.data;
  }

  /** Cancel an active rally point (Req 20.5). */
  async cancelRally(groupId: string, rallyId: string): Promise<void> {
    await apiClient.delete(`/api/v1/groups/${groupId}/rally/${rallyId}`);
  }

  /** Broadcast an SOS pin to the active group (Req 25.1–25.3). */
  async broadcastGroupSos(
    groupId: string,
    lat: number,
    lng: number,
    type: SosType = 'general',
  ): Promise<SosPin> {
    const res = await apiClient.post<SosPin>(`/api/v1/groups/${groupId}/sos`, { lat, lng, type });
    return res.data;
  }

  /** Broadcast an SOS to friends when no active group (Req 25.7). */
  async broadcastStandaloneSos(
    lat: number,
    lng: number,
    type: SosType = 'general',
  ): Promise<SosPin> {
    const res = await apiClient.post<SosPin>('/api/v1/sos', { lat, lng, type });
    return res.data;
  }

  /** Cancel a standalone SOS pin (no active group). */
  async cancelStandaloneSos(sosId: string): Promise<void> {
    await apiClient.delete(`/api/v1/sos/${sosId}`);
  }

  /** Cancel an SOS pin (Req 25.6). */
  async cancelSos(groupId: string, sosId: string): Promise<void> {
    await apiClient.delete(`/api/v1/groups/${groupId}/sos/${sosId}`);
  }
}

export const rallyService = new RallyService();

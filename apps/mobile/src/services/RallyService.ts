/**
 * RallyService — broadcast/cancel rally points and SOS pins.
 * Requirements: 20.1–20.6, 25.1–25.7
 */

import { apiClient } from './apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RallyPoint {
  id: string;
  broadcasterId: string;
  lat: number;
  lng: number;
  address: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface SosPin {
  id: string;
  userId: string;
  groupId: string | null;
  lat: number;
  lng: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class RallyService {
  /** Broadcast a rally point to the active group (Req 20.1). */
  async broadcastRally(groupId: string, lat: number, lng: number): Promise<RallyPoint> {
    const res = await apiClient.post<RallyPoint>(`/api/v1/groups/${groupId}/rally`, { lat, lng });
    return res.data;
  }

  /** Cancel an active rally point (Req 20.5). */
  async cancelRally(groupId: string, rallyId: string): Promise<void> {
    await apiClient.delete(`/api/v1/groups/${groupId}/rally/${rallyId}`);
  }

  /** Broadcast an SOS pin to the active group (Req 25.1–25.3). */
  async broadcastGroupSos(groupId: string, lat: number, lng: number): Promise<SosPin> {
    const res = await apiClient.post<SosPin>(`/api/v1/groups/${groupId}/sos`, { lat, lng });
    return res.data;
  }

  /** Broadcast an SOS to friends when no active group (Req 25.7). */
  async broadcastStandaloneSos(lat: number, lng: number): Promise<SosPin> {
    const res = await apiClient.post<SosPin>('/api/v1/sos', { lat, lng });
    return res.data;
  }

  /** Cancel an SOS pin (Req 25.6). */
  async cancelSos(groupId: string, sosId: string): Promise<void> {
    await apiClient.delete(`/api/v1/groups/${groupId}/sos/${sosId}`);
  }
}

export const rallyService = new RallyService();

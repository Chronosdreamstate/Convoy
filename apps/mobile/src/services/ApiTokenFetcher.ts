/**
 * ApiTokenFetcher — fetches short-lived Agora RTC tokens from the backend.
 * Implements the ITokenFetcher interface consumed by PTTService.
 */

import type { ITokenFetcher } from './PTTService';
import { apiClient } from './apiClient';

interface PttTokenResponse {
  token: string;
  uid: number;
  channelName: string;
  expiresAt: string;
}

class ApiTokenFetcher implements ITokenFetcher {
  async fetchToken(groupId: string, channelId: string): Promise<PttTokenResponse> {
    const res = await apiClient.post<PttTokenResponse>('/api/v1/ptt/token', {
      groupId,
      channelId,
    });
    return res.data;
  }
}

export const apiTokenFetcher = new ApiTokenFetcher();

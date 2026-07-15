import { Pool } from 'pg';
import { IPushGateway } from './notification.worker';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoReceipt {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Transient delivery failure (network error reaching Expo, 429 rate limit,
 * Expo 5xx). Thrown so the BullMQ worker's retry/backoff redelivers the job —
 * swallowing these silently lost notifications (Req 15.1) because jobs only
 * run once when nothing throws.
 */
export class PushGatewayTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushGatewayTransientError';
  }
}

export class ExpoPushGateway implements IPushGateway {
  constructor(private readonly db: Pool) {}

  async send(
    token: string,
    _platform: 'ios' | 'android',
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
      priority: 'normal' | 'high';
      categoryIdentifier?: string;
    },
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          to: token,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          priority: payload.priority === 'high' ? 'high' : 'default',
          sound: 'default',
          ...(payload.categoryIdentifier ? { categoryId: payload.categoryIdentifier } : {}),
        }),
      });
    } catch (err) {
      // Network error reaching Expo — retryable.
      throw new PushGatewayTransientError(
        `Expo push request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        // Rate-limited or Expo-side outage — retryable.
        throw new PushGatewayTransientError(`Expo push HTTP ${res.status}`);
      }
      // Other 4xx = malformed request; retrying would fail identically.
      return;
    }

    let result: { data: ExpoReceipt };
    try {
      result = (await res.json()) as { data: ExpoReceipt };
    } catch {
      return;
    }

    if (
      result.data.status === 'error' &&
      result.data.details?.error === 'DeviceNotRegistered'
    ) {
      // Token is stale — remove to avoid future sends
      await this.db.query('DELETE FROM devices WHERE push_token = $1', [token]);
    }
  }
}

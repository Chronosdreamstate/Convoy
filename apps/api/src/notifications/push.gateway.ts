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

    let result: { data?: ExpoReceipt | ExpoReceipt[] };
    try {
      result = (await res.json()) as { data?: ExpoReceipt | ExpoReceipt[] };
    } catch {
      return;
    }

    // Expo mirrors the request shape: a single message object answers with a
    // single ticket, an array of messages with an array of tickets. We send one
    // message per call, but accept both so a shape difference can never
    // silently disable ticket handling altogether.
    const raw = result.data;
    const tickets: ExpoReceipt[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

    for (const ticket of tickets) {
      if (ticket.status !== 'error') continue;

      if (ticket.details?.error === 'DeviceNotRegistered') {
        // Token is stale — remove to avoid future sends
        await this.db.query('DELETE FROM devices WHERE push_token = $1', [token]);
        continue;
      }

      if (ticket.details?.error === 'MessageRateExceeded') {
        // Expo answers HTTP 200 with a PER-MESSAGE rate-limit ticket when one
        // token is pushed too fast (an SOS landing on top of a gap alert on top
        // of a hazard alert for the same phone). That ticket was read as
        // "delivered" and the notification dropped outright — unlike a 429 on
        // the HTTP response itself, which is already retried. Throw so BullMQ
        // redelivers the job with backoff.
        throw new PushGatewayTransientError('Expo push ticket: MessageRateExceeded');
      }
    }
  }
}

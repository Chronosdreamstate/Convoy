import { Pool } from 'pg';
import { IPushGateway } from './notification.worker';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoReceipt {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
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
        }),
      });
    } catch {
      return; // network error — non-fatal
    }

    if (!res.ok) return;

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

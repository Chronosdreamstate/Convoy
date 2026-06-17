import { Pool } from 'pg';
import { IDeviceStore, IPreferenceStore } from './notification.worker';

export class PostgresDeviceStore implements IDeviceStore {
  constructor(private readonly db: Pool) {}

  async getTokensForUser(
    userId: string,
  ): Promise<Array<{ token: string; platform: 'ios' | 'android' }>> {
    const result = await this.db.query<{ push_token: string; platform: 'ios' | 'android' }>(
      'SELECT push_token, platform FROM devices WHERE user_id = $1',
      [userId],
    );
    return result.rows.map((r) => ({ token: r.push_token, platform: r.platform }));
  }
}

export class PostgresPreferenceStore implements IPreferenceStore {
  constructor(private readonly db: Pool) {}

  async getPreferences(userId: string): Promise<{
    notif_hazard: boolean;
    notif_group_events: boolean;
    notif_friend_requests: boolean;
    notif_navigation: boolean;
  } | null> {
    const result = await this.db.query<{
      notif_hazard: boolean;
      notif_group_events: boolean;
      notif_friend_requests: boolean;
      notif_navigation: boolean;
    }>(
      `SELECT notif_hazard, notif_group_events, notif_friend_requests, notif_navigation
       FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }
}

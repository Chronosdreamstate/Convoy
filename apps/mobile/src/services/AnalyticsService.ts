import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiClient } from './apiClient';

export type AnalyticsEvent =
  | { name: 'convoy_started'; props: { groupSize: number } }
  | { name: 'convoy_ended'; props: { durationMin: number; distanceKm: number } }
  | { name: 'ptt_used'; props: { durationSec: number } }
  | { name: 'hazard_reported'; props: { type: string } }
  | { name: 'group_created'; props: Record<string, never> }
  | { name: 'group_joined'; props: Record<string, never> }
  | { name: 'waypoint_added'; props: { type: string } }
  | { name: 'event_rsvp'; props: { status: string } }
  | { name: 'friend_added'; props: Record<string, never> }
  | { name: 'screen_viewed'; props: { screen: string } }
  | { name: 'share_triggered'; props: { surface: string } }
  | { name: 'notification_tapped'; props: { type: string } }
  | { name: 'map_style_changed'; props: { style: string } };

const QUEUE_KEY = '@convoy/analytics_queue';
const ANON_ID_KEY = '@convoy/anon_id';
const MAX_QUEUE = 50;
const FLUSH_AT = 10;


class Analytics {
  private queue: Array<{ event: string; props: Record<string, unknown>; ts: number }> = [];
  private flushing = false;
  private anonymousId: string | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    let id = await AsyncStorage.getItem(ANON_ID_KEY);
    if (!id) {
      id = Math.random().toString(36).substring(2) + Date.now().toString(36);
      await AsyncStorage.setItem(ANON_ID_KEY, id);
    }
    this.anonymousId = id;

    const saved = await AsyncStorage.getItem(QUEUE_KEY);
    if (saved) {
      try { this.queue = JSON.parse(saved) as typeof this.queue; } catch { this.queue = []; }
    }
  }

  track(event: AnalyticsEvent): void {
    const entry = {
      event: event.name,
      props: event.props as Record<string, unknown>,
      ts: Date.now(),
    };
    this.queue.push(entry);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue)).catch(() => {});
    if (this.queue.length >= FLUSH_AT) void this.flush();
  }

  screen(name: string): void {
    this.track({ name: 'screen_viewed', props: { screen: name } });
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, 20);
    try {
      await apiClient.post('/api/v1/analytics/events', {
        anonymousId: this.anonymousId,
        platform: Platform.OS,
        events: batch,
      });
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue));
    } catch {
      this.queue = [...batch, ...this.queue].slice(0, MAX_QUEUE);
    } finally {
      this.flushing = false;
    }
  }
}

export const analytics = new Analytics();

/**
 * OfflineQueueService — general-purpose write queue for arbitrary API calls.
 * Complements OfflineCacheService (which handles hazards and drives via SQLite).
 * This queue handles lighter writes: RSVPs, friend requests, profile updates, etc.
 * Uses AsyncStorage so it survives app restarts.
 * Requirements: 19.7 (offline resilience)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, AppStateStatus } from 'react-native';
import { apiClient } from './apiClient';

const QUEUE_KEY = '@convoy/offline_request_queue';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ATTEMPTS = 5;
const MAX_QUEUE_SIZE = 100;

export interface QueuedRequest {
  id: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body: unknown;
  headers: Record<string, string>;
  queuedAt: number;
  attempts: number;
  /** Optional tag to deduplicate (e.g. 'rsvp:event-123' — newer replaces older) */
  dedupeKey?: string;
}

class OfflineQueueService {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private appStateSub: { remove: () => void } | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const saved = await AsyncStorage.getItem(QUEUE_KEY).catch(() => null);
    if (saved) {
      try {
        this.queue = JSON.parse(saved) as QueuedRequest[];
      } catch {
        this.queue = [];
      }
    }

    // Drain queue whenever the app comes to foreground
    this.appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active' && this.queue.length > 0) {
        void this.processQueue();
      }
    });

    // Attempt to drain on init (covers hot restarts where connectivity is already up)
    if (this.queue.length > 0) {
      void this.processQueue();
    }
  }

  /**
   * Add a request to the queue.
   * If dedupeKey is provided and a queued item with the same key exists, it is replaced.
   */
  async enqueue(request: Omit<QueuedRequest, 'id' | 'queuedAt' | 'attempts'>): Promise<string> {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const item: QueuedRequest = { ...request, id, queuedAt: Date.now(), attempts: 0 };

    if (item.dedupeKey) {
      this.queue = this.queue.filter((q) => q.dedupeKey !== item.dedupeKey);
    }

    this.queue.push(item);

    // Cap queue size — drop oldest items first
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(this.queue.length - MAX_QUEUE_SIZE);
    }

    await this.persist();
    return id;
  }

  /**
   * Remove a specific queued item by id (call after a successful online request
   * that was speculatively added to the queue).
   */
  async cancel(id: string): Promise<void> {
    this.queue = this.queue.filter((q) => q.id !== id);
    await this.persist();
  }

  async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const snapshot = [...this.queue];
    for (const item of snapshot) {
      // Expire stale items
      if (Date.now() - item.queuedAt > MAX_AGE_MS || item.attempts >= MAX_ATTEMPTS) {
        this.queue = this.queue.filter((q) => q.id !== item.id);
        continue;
      }

      try {
        // Extract path+query from stored full URL so apiClient can attach a fresh token
        const parsed = new URL(item.url);
        const path = parsed.pathname + parsed.search;
        await apiClient.request({ method: item.method, url: path, data: item.body ?? undefined });
        this.queue = this.queue.filter((q) => q.id !== item.id);
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status != null && status === 409) {
          // Conflict = already applied, treat as success
          this.queue = this.queue.filter((q) => q.id !== item.id);
        } else if (status != null && status >= 400 && status < 500) {
          // Non-retriable client error — drop
          this.queue = this.queue.filter((q) => q.id !== item.id);
        } else {
          // Network error or 5xx — keep, backoff handled by apiClient retry interceptor
          item.attempts++;
        }
      }
    }

    await this.persist();
    this.processing = false;
  }

  get size(): number {
    return this.queue.length;
  }

  destroy(): void {
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.initialized = false;
  }

  private async persist(): Promise<void> {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue)).catch(() => {});
  }
}

export const offlineQueue = new OfflineQueueService();

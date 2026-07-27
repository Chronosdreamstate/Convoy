/**
 * Unit tests for NotificationCenterScreen's offline read-state reconciliation.
 * Requirements: 15.4, 19.7 (offline resilience)
 *
 * User story: the driver opens the notification center in a dead zone, taps a
 * few notifications (marking them read locally — the PATCH is queued), then
 * reconnects and pulls to refresh. The server page still says those rows are
 * unread because the queued PATCH hasn't replayed yet. mergeServerNotifications
 * must keep local read-state (read is monotonic) while still treating the
 * server as the source of truth for which notifications exist.
 */

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));
jest.mock('../services/apiClient', () => ({
  apiClient: { get: jest.fn(), patch: jest.fn() },
}));
jest.mock('../services/OfflineQueueService', () => ({
  offlineQueue: { enqueue: jest.fn() },
  isOfflineError: jest.fn(),
}));

import { mergeServerNotifications, prependRealtime, NotificationItem } from './NotificationCenterScreen';

function makeItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    type: 'hazard_alert',
    title: 'Hazard ahead',
    body: 'Pothole reported',
    createdAt: '2026-07-13T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('mergeServerNotifications', () => {
  it('preserves local readAt when the server copy is still unread (queued mark-read PATCH)', () => {
    const local = [makeItem({ id: 'a', readAt: '2026-07-13T10:05:00.000Z' })];
    const fresh = [makeItem({ id: 'a', readAt: null })];

    const merged = mergeServerNotifications(local, fresh);

    expect(merged).toHaveLength(1);
    expect(merged[0].readAt).toBe('2026-07-13T10:05:00.000Z');
  });

  it('keeps the server readAt when the server already knows the item was read', () => {
    const local = [makeItem({ id: 'a', readAt: '2026-07-13T10:05:00.000Z' })];
    const fresh = [makeItem({ id: 'a', readAt: '2026-07-13T09:00:00.000Z' })];

    const merged = mergeServerNotifications(local, fresh);
    expect(merged[0].readAt).toBe('2026-07-13T09:00:00.000Z');
  });

  it('passes brand-new server items through unchanged', () => {
    const local: NotificationItem[] = [];
    const fresh = [makeItem({ id: 'new-1' }), makeItem({ id: 'new-2', readAt: '2026-07-13T08:00:00.000Z' })];

    const merged = mergeServerNotifications(local, fresh);
    expect(merged).toEqual(fresh);
  });

  it('drops local-only items — the server stays the source of truth for membership', () => {
    const local = [makeItem({ id: 'socket-only-sos-123' })];
    const fresh = [makeItem({ id: 'server-1' })];

    const merged = mergeServerNotifications(local, fresh);
    expect(merged.map((n) => n.id)).toEqual(['server-1']);
  });

  it('unread local + unread server stays unread', () => {
    const local = [makeItem({ id: 'a', readAt: null })];
    const fresh = [makeItem({ id: 'a', readAt: null })];

    const merged = mergeServerNotifications(local, fresh);
    expect(merged[0].readAt).toBeNull();
  });

  it('reconciles a mixed page: read-locally rows keep readAt, others follow the server', () => {
    const local = [
      makeItem({ id: 'a', readAt: '2026-07-13T10:05:00.000Z' }),
      makeItem({ id: 'b', readAt: null }),
    ];
    const fresh = [
      makeItem({ id: 'a', readAt: null }),
      makeItem({ id: 'b', readAt: null }),
      makeItem({ id: 'c', readAt: null }),
    ];

    const merged = mergeServerNotifications(local, fresh);
    expect(merged.find((n) => n.id === 'a')?.readAt).toBe('2026-07-13T10:05:00.000Z');
    expect(merged.find((n) => n.id === 'b')?.readAt).toBeNull();
    expect(merged.find((n) => n.id === 'c')?.readAt).toBeNull();
  });
});

describe('prependRealtime — gap-alert de-duplication', () => {
  const gap = (groupId: string, memberId: string): NotificationItem =>
    makeItem({ id: `gap-${groupId}-${memberId}`, type: 'gap_alert', title: 'Rider fell behind' });

  it('collapses repeated same-member gap ticks to a single row (stable id)', () => {
    // One lag episode fires gap:alert every ~3s; every tick carries the same
    // stable id, so the center must hold exactly one row for that member.
    let state: NotificationItem[] = [];
    for (let i = 0; i < 20; i++) {
      state = prependRealtime(state, [gap('g1', 'm1')]);
    }
    expect(state).toHaveLength(1);
    expect(state[0].id).toBe('gap-g1-m1');
  });

  it('keeps a separate row per distinct member falling behind', () => {
    let state: NotificationItem[] = [];
    state = prependRealtime(state, [gap('g1', 'm1')]);
    state = prependRealtime(state, [gap('g1', 'm2')]);
    state = prependRealtime(state, [gap('g1', 'm1')]); // m1 again — no new row
    expect(state.map((n) => n.id).sort()).toEqual(['gap-g1-m1', 'gap-g1-m2']);
  });

  it('preserves the existing row (position + read-state) when a duplicate arrives', () => {
    const read = { ...gap('g1', 'm1'), readAt: '2026-07-13T10:05:00.000Z' };
    const merged = prependRealtime([read], [gap('g1', 'm1')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].readAt).toBe('2026-07-13T10:05:00.000Z'); // not resurrected as unread
  });

  it('prepends genuinely new items newest-first and honors the cap', () => {
    const prev = [makeItem({ id: 'old' })];
    const merged = prependRealtime(prev, [makeItem({ id: 'new' })], 5);
    expect(merged.map((n) => n.id)).toEqual(['new', 'old']);
  });
});

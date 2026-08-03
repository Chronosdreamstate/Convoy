/**
 * Unit tests for routeNotificationTap — the notification-tap → screen mapping
 * used by app/_layout.tsx for both warm taps and cold-start launches.
 *
 * Focus: the group_invite dead end (Req 15.4). Tapping a group-invite push
 * used to land on the EMPTY join-code entry screen; it must now land
 * somewhere actionable:
 *   - payload with joinCode  → /join prefilled with the code
 *   - payload with groupId   → the group detail screen
 *   - payload with neither   → /join (legacy fallback)
 */

// NotificationService imports expo modules at module level; mock them so the
// pure routing function can be tested in isolation.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  AndroidImportance: { MAX: 5 },
}));
jest.mock('expo-device', () => ({ isDevice: false }));
jest.mock('./apiClient', () => ({
  apiClient: { post: jest.fn(), get: jest.fn() },
}));
jest.mock('./OfflineQueueService', () => ({
  offlineQueue: { enqueue: jest.fn() },
  isOfflineError: () => false,
}));

import { routeNotificationTap, INotificationRouter } from './NotificationService';

type PushedRoute = string | { pathname: string; params?: Record<string, string> };

function buildRouter(): INotificationRouter & { pushed: PushedRoute[] } {
  const pushed: PushedRoute[] = [];
  return { pushed, push: (route: PushedRoute) => { pushed.push(route); } };
}

describe('routeNotificationTap — group_invite', () => {
  it('prefills the join screen when the payload carries a joinCode', () => {
    const router = buildRouter();
    routeNotificationTap(router, { type: 'group_invite', joinCode: 'ABC123' });

    expect(router.pushed).toEqual([
      { pathname: '/join', params: { prefillCode: 'ABC123' } },
    ]);
  });

  it('navigates to the group detail when the payload carries a groupId (join-request lifecycle)', () => {
    const router = buildRouter();
    // Matches the server payload shape in api/src/groups/joinRequests.routes.ts
    routeNotificationTap(router, {
      type: 'group_invite',
      groupId: 'group-42',
      requestId: 'req-7',
    });

    expect(router.pushed).toEqual(['/group/group-42']);
  });

  it('prefers the joinCode over the groupId when both are present', () => {
    const router = buildRouter();
    routeNotificationTap(router, {
      type: 'group_invite',
      joinCode: 'ZZTOP1',
      groupId: 'group-42',
    });

    expect(router.pushed).toEqual([
      { pathname: '/join', params: { prefillCode: 'ZZTOP1' } },
    ]);
  });

  it('URL-encodes the groupId path segment', () => {
    const router = buildRouter();
    routeNotificationTap(router, { type: 'group_invite', groupId: 'a/b c' });

    expect(router.pushed).toEqual([`/group/${encodeURIComponent('a/b c')}`]);
  });

  it('falls back to the bare join screen when the payload has neither code nor group', () => {
    const router = buildRouter();
    routeNotificationTap(router, { type: 'group_invite' });

    expect(router.pushed).toEqual(['/join']);
  });
});

describe('routeNotificationTap — other categories unchanged', () => {
  it.each([
    ['sos_alert', '/(tabs)/map'],
    ['rally_point', '/(tabs)/map'],
    ['hazard_alert', '/(tabs)/map'],
    ['gap_alert', '/(tabs)/map'],
    ['fuel_suggest', '/(tabs)/map'],
    ['arriving_destination', '/(tabs)/map'],
  ] as const)('%s routes to %s', (type, expected) => {
    const router = buildRouter();
    routeNotificationTap(router, { type });
    expect(router.pushed).toEqual([expected]);
  });

  it('friend_request routes to the requests tab', () => {
    const router = buildRouter();
    routeNotificationTap(router, { type: 'friend_request' });
    expect(router.pushed).toEqual([
      { pathname: '/friends', params: { tab: 'requests' } },
    ]);
  });

  it('group_event with ids routes to the event, without ids to the convoy tab', () => {
    const withIds = buildRouter();
    routeNotificationTap(withIds, { type: 'group_event', eventId: 'e1', groupId: 'g1' });
    expect(withIds.pushed).toEqual([
      { pathname: '/event/[id]', params: { id: 'e1', groupId: 'g1' } },
    ]);

    const withoutIds = buildRouter();
    routeNotificationTap(withoutIds, { type: 'group_event' });
    expect(withoutIds.pushed).toEqual(['/(tabs)/convoy']);
  });

  it('event_reminder lands on the event, like the announcement that created it', () => {
    // "Remind attendees" delivers this as a real push now (it used to write
    // history rows and send nothing), so its tap has to go somewhere — it
    // would previously have fallen through to `default`.
    const router = buildRouter();
    routeNotificationTap(router, { type: 'event_reminder', eventId: 'e1', groupId: 'g1' });
    expect(router.pushed).toEqual([
      { pathname: '/event/[id]', params: { id: 'e1', groupId: 'g1' } },
    ]);
  });

  it('does nothing for an unknown or missing type', () => {
    const router = buildRouter();
    routeNotificationTap(router, { type: 'mystery' });
    routeNotificationTap(router, {});
    routeNotificationTap(router, undefined);
    expect(router.pushed).toEqual([]);
  });
});

/**
 * A cold start delivers the notification tap that launched the app, and the
 * invite link the user followed, before the app has a navigator to send them
 * to. These pin that neither is lost.
 */

import { createDeferredRouter, type NavRoute } from './pendingNavigation';
import { parseDeepLink } from './deepLink';
import { routeNotificationTap } from '../services/NotificationService';

function harness(startReady = false) {
  const pushed: NavRoute[] = [];
  let ready = startReady;
  const deferred = createDeferredRouter({
    isReady: () => ready,
    getRouter: () => ({ push: (route: NavRoute) => pushed.push(route) }),
  });
  return {
    deferred,
    pushed,
    becomeReady: () => {
      ready = true;
      deferred.flush();
    },
  };
}

describe('createDeferredRouter', () => {
  it('passes a push straight through once the app is ready', () => {
    const { deferred, pushed } = harness(true);

    deferred.push('/friends');

    expect(pushed).toEqual(['/friends']);
    expect(deferred.pending()).toBeNull();
  });

  it('holds a push made before the app is ready, and replays it after', () => {
    const { deferred, pushed, becomeReady } = harness();

    deferred.push({ pathname: '/join', params: { prefillCode: 'ABC123' } });

    // Nothing yet — the Stack is not mounted and a redirect is still pending.
    expect(pushed).toEqual([]);
    expect(deferred.pending()).not.toBeNull();

    becomeReady();

    expect(pushed).toEqual([{ pathname: '/join', params: { prefillCode: 'ABC123' } }]);
    expect(deferred.pending()).toBeNull();
  });

  it('replays only once, however often flush is called', () => {
    const { deferred, pushed, becomeReady } = harness();

    deferred.push('/notifications');
    becomeReady();
    deferred.flush();
    deferred.flush();

    expect(pushed).toEqual(['/notifications']);
  });

  it('keeps the most recent intent when two arrive before the app is ready', () => {
    // Two competing answers to "what did the user just ask for" — stacking
    // both screens is worse than honouring the one they acted on last.
    const { deferred, pushed, becomeReady } = harness();

    deferred.push('/(tabs)/map');
    deferred.push({ pathname: '/invite', params: { userId: 'u-1' } });
    becomeReady();

    expect(pushed).toEqual([{ pathname: '/invite', params: { userId: 'u-1' } }]);
  });

  it('does nothing when there was no intent to hold', () => {
    const { pushed, becomeReady } = harness();

    becomeReady();

    expect(pushed).toEqual([]);
  });
});

describe('cold start: the intent survives to the screen it names', () => {
  it('carries an invite link through a signed-out start and a sign-up', () => {
    // Follow a shared link while signed out: the guard sends the visitor to
    // welcome, they sign up, and only then is there anywhere to navigate to.
    const { deferred, pushed, becomeReady } = harness();

    const url = 'https://convoy.app/join?code=ABC123';
    const route = parseDeepLink(url);
    expect(route).not.toBeNull();
    deferred.push(route as NavRoute);

    expect(pushed).toEqual([]);

    becomeReady();

    expect(pushed).toEqual([{ pathname: '/join', params: { prefillCode: 'ABC123' } }]);
  });

  it('carries the notification that launched the app', () => {
    const { deferred, pushed, becomeReady } = harness();

    routeNotificationTap(deferred, { type: 'friend_request' });

    expect(pushed).toEqual([]);

    becomeReady();

    expect(pushed).toEqual([{ pathname: '/friends', params: { tab: 'requests' } }]);
  });
});

describe('parseDeepLink', () => {
  it.each([
    ['convoy://join?code=XYZ789', { pathname: '/join', params: { prefillCode: 'XYZ789' } }],
    ['https://convoy.app/join?code=XYZ789', { pathname: '/join', params: { prefillCode: 'XYZ789' } }],
    ['convoy://invite?userId=u-42', { pathname: '/invite', params: { userId: 'u-42' } }],
    ['https://convoy.app/invite/u-42', { pathname: '/invite', params: { userId: 'u-42' } }],
    ['convoy://group?userId=g-7', '/group/g-7'],
  ])('parses %s', (url, expected) => {
    expect(parseDeepLink(url)).toEqual(expected);
  });

  it.each([
    'https://evil.example.com/join?code=ABC123', // not our host
    'convoy://join', // no code
    'convoy://unknown?code=ABC123',
    'not a url at all',
  ])('ignores %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });
});

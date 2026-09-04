/**
 * Turns a convoy:// or https://convoy.app/ link into the route it means.
 *
 * Pure so the link formats can be pinned by tests: these URLs are minted by
 * other people's share sheets and by the API's invite emails, and a silent
 * parse change would break the one flow a brand-new user arrives through.
 * The navigation itself (and the holding of it until the app can act — see
 * pendingNavigation.ts) happens in app/_layout.tsx.
 */

import type { NavRoute } from './pendingNavigation';

export function parseDeepLink(url: string): NavRoute | null {
  try {
    const parsed = new URL(url);
    let path = '';
    let code: string | null = null;
    let userId: string | null = null;

    if (parsed.protocol === 'convoy:') {
      // convoy://join?code=XXX  or  convoy://invite?userId=XXX
      path = parsed.hostname;
      code = parsed.searchParams.get('code');
      userId = parsed.searchParams.get('userId');
    } else if (parsed.protocol === 'https:' && parsed.hostname === 'convoy.app') {
      // https://convoy.app/join?code=XXX  or  https://convoy.app/invite/USER_ID
      const segments = parsed.pathname.replace(/^\//, '').split('/');
      path = segments[0] ?? '';
      code = parsed.searchParams.get('code');
      userId = segments[1] ?? null;
    } else {
      return null;
    }

    if (path === 'join' && code) {
      return { pathname: '/join', params: { prefillCode: code } };
    }
    if (path === 'invite' && userId) {
      // A user-invite link (e.g. from the Friends "invite" share sheet) — takes
      // the recipient to app/invite.tsx, NOT a group. Do not confuse this with
      // the 'group' case below, which shares a group id in the same slot.
      return { pathname: '/invite', params: { userId } };
    }
    if (path === 'group' && userId) {
      return `/group/${encodeURIComponent(userId)}`;
    }
    return null;
  } catch {
    // malformed URL — ignore
    return null;
  }
}

/**
 * Navigation intents that arrive before the app can act on them.
 *
 * A cold start delivers the two most important entry points into the app —
 * the tapped push notification that launched it, and the invite deep link the
 * user followed — within the first frame, while `app/_layout.tsx` is still
 * showing the splash and the <Stack> has not been rendered at all. Anything
 * pushed then goes nowhere. Even once the Stack mounts, `app/index.tsx`
 * redirects to the map and the auth guard redirects a signed-out visitor to
 * the welcome screen, either of which replaces the destination.
 *
 * So the intent is held rather than fired, and replayed the moment the app is
 * actually somewhere it can navigate from. For a signed-out visitor that is
 * after they finish signing up — which is exactly the invite flow: follow a
 * shared link, create an account, land on the join screen with the code
 * already filled in, instead of being dropped on the map with no idea what
 * the link was for.
 */

export type NavRoute = string | { pathname: string; params?: Record<string, string> };

/** The `push`-only surface both routeNotificationTap and the deep-link handler
 * need; expo-router's Router satisfies it. */
export interface PushRouter {
  push(route: NavRoute): void;
}

export interface DeferredRouter extends PushRouter {
  /** Replay a held intent, if there is one and the app is ready for it. */
  flush(): void;
  /** The intent currently being held, for tests and diagnostics. */
  pending(): NavRoute | null;
}

/**
 * Wraps a real router so that pushes made before `isReady()` are held instead
 * of lost.
 *
 * Only the most recent intent is kept. Two arriving before the app is ready
 * means two competing answers to "what did the user just ask for" — replaying
 * both would stack one screen on top of the other, and the later one is the
 * one they acted on.
 */
export function createDeferredRouter(opts: {
  isReady: () => boolean;
  getRouter: () => PushRouter | null;
}): DeferredRouter {
  let held: NavRoute | null = null;

  const deliver = (route: NavRoute): boolean => {
    const router = opts.getRouter();
    if (!router) return false;
    router.push(route);
    return true;
  };

  return {
    push(route: NavRoute): void {
      if (opts.isReady() && deliver(route)) return;
      held = route;
    },
    flush(): void {
      if (held === null || !opts.isReady()) return;
      const route = held;
      // Cleared before delivering so a push made from the destination screen
      // cannot be swallowed by a re-entrant flush.
      held = null;
      if (!deliver(route)) held = route;
    },
    pending(): NavRoute | null {
      return held;
    },
  };
}

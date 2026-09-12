/**
 * Avatar fallbacks for text authored by other people.
 *
 * Twelve screens each had their own copy of "derive initials from a display
 * name", and every one of them started with `name.trim()` on a value taken
 * straight out of an API payload. A render-smoke sweep caught two of those
 * (UserProfileScreen and app/invite.tsx) dying with
 * `Cannot read properties of undefined (reading 'trim')` on a 200 response
 * that simply didn't carry `displayName` — the fix was applied there and
 * nowhere else, leaving ten copies of the same crash.
 *
 * These are the one guarded implementation. They take `unknown` on purpose:
 * the argument is always a field off a network payload, and the whole point
 * is that it may not be the string the type says it is.
 */

/**
 * Deterministic decorative palette for an initials bubble — deliberately NOT
 * theme chrome, so a given person's bubble is the same color in light and
 * dark mode, and the same color on every screen that lists them.
 */
export const AVATAR_COLORS = [
  '#DC143C', '#6366F1', '#0EA5E9', '#10B981',
  '#F59E0B', '#EC4899', '#8B5CF6', '#14B8A6',
] as const;

/**
 * Up to two uppercase initials for `name` — "Jo Bloggs" → "JB".
 *
 * Returns `fallback` (default: the empty string, i.e. a plain colored
 * bubble) when there is nothing to take an initial from: a missing field, a
 * non-string, an empty name, or a whitespace-only one. Pass `'?'` where the
 * bubble would otherwise look broken rather than merely blank.
 *
 * Code points, not UTF-16 units: `name[0]` on a display name starting with an
 * emoji returns half a surrogate pair, which renders as a replacement glyph.
 */
export function initials(name: unknown, fallback = ''): string {
  if (typeof name !== 'string') return fallback;
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
  return letters || fallback;
}

/**
 * A stable color from AVATAR_COLORS for `name`. Same guard as `initials`: a
 * missing name hashes as the empty string rather than throwing on `.length`.
 */
export function avatarColor(name: unknown): string {
  const source = typeof name === 'string' ? name : '';
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) & 0xffff;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * The guard is the point: every call site passes a field off an API payload,
 * and the crash this helper exists to stop is `name.trim()` on a 200 response
 * that didn't carry the field (already seen live on UserProfileScreen and
 * app/invite.tsx).
 */

import { AVATAR_COLORS, avatarColor, initials } from './avatar';

describe('initials', () => {
  it('takes up to two initials', () => {
    expect(initials('Jo Bloggs')).toBe('JB');
    expect(initials('jo bloggs')).toBe('JB');
    expect(initials('Jo Middle Bloggs')).toBe('JM');
    expect(initials('Jo')).toBe('J');
  });

  it('does not throw on a name the payload never carried', () => {
    expect(() => initials(undefined)).not.toThrow();
    expect(() => initials(null)).not.toThrow();
    expect(() => initials(42)).not.toThrow();
    expect(() => initials({ displayName: 'Jo' })).not.toThrow();
    expect(initials(undefined)).toBe('');
    expect(initials(null)).toBe('');
  });

  it('falls back for an empty or whitespace-only name', () => {
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
    expect(initials('\n\t ')).toBe('');
    expect(initials(undefined, '?')).toBe('?');
    expect(initials('   ', '?')).toBe('?');
  });

  it('ignores padding and repeated spaces between words', () => {
    // `.split(' ')` without a filter turned "Jo  Bloggs" into ['Jo','','Bloggs']
    // and produced just "J" — some copies of this helper did exactly that.
    expect(initials('  Jo   Bloggs  ')).toBe('JB');
    expect(initials('Jo\tBloggs')).toBe('JB');
  });

  it('takes a whole code point, not half a surrogate pair', () => {
    // `'🏎 Racer'[0]` is a lone high surrogate, which renders as a replacement
    // glyph in the bubble.
    const result = initials('🏎 Racer');
    expect(result.startsWith('🏎')).toBe(true);
    expect(result.endsWith('R')).toBe(true);
  });
});

describe('avatarColor', () => {
  it('is stable for a name and comes from the palette', () => {
    expect(avatarColor('Jo Bloggs')).toBe(avatarColor('Jo Bloggs'));
    expect(AVATAR_COLORS).toContain(avatarColor('Jo Bloggs'));
  });

  it('does not throw on a name the payload never carried', () => {
    expect(() => avatarColor(undefined)).not.toThrow();
    expect(() => avatarColor(null)).not.toThrow();
    expect(AVATAR_COLORS).toContain(avatarColor(undefined));
  });
});

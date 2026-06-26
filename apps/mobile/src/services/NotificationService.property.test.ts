/**
 * Property tests for NotificationService.
 *
 * Property 113: registerToken never throws regardless of permission outcome
 *   Whether permission is granted or denied, registerToken resolves without
 *   throwing — the app must never crash due to notification setup.
 *   Validates: Requirements 15.1, 15.2
 *
 * Property 114: registerToken only POSTs a token when permission is granted
 *   When permission is denied at any stage (existing or after request),
 *   no device token is sent to the API. apiClient.post is never called.
 *   Validates: Requirements 15.1, 15.2
 *
 * Property 115: isRegistered reflects successful registration
 *   After a successful registerToken (granted + token obtained), isRegistered
 *   is true. After permission denial, it remains false.
 *   Validates: Requirements 15.3
 *
 * Property 116: handleForeground and handleTap are pure dispatchers
 *   For any NotificationCategory and any data record, the handler receives
 *   exactly the same category and data that was passed in — no mutation.
 *   Validates: Requirements 15.4, 15.5
 *
 * Property 117: Simulator short-circuit prevents token fetch and API call
 *   When isDevice() returns false, neither getExpoPushTokenAsync nor the API
 *   is called — regardless of permission state.
 *   Validates: Requirements 15.1
 */

import fc from 'fast-check';
import { NotificationService, NotificationCategory, IExpoPushTokenProvider, INotificationHandler } from './NotificationService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function buildTokenProvider(overrides: Partial<{
  isDevice: boolean;
  platform: 'ios' | 'android';
  existingStatus: string;
  requestedStatus: string;
  tokenData: string;
}>): IExpoPushTokenProvider & { channelCalls: string[] } {
  const {
    isDevice = true,
    platform = 'ios',
    existingStatus = 'undetermined',
    requestedStatus = 'granted',
    tokenData = 'ExponentPushToken[xxxxxx]',
  } = overrides;

  const channelCalls: string[] = [];

  return {
    channelCalls,
    isDevice: jest.fn(() => isDevice),
    getPlatform: jest.fn(() => platform),
    getPermissionsAsync: jest.fn().mockResolvedValue({ status: existingStatus }),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ status: requestedStatus }),
    getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: tokenData }),
    setNotificationChannelAsync: jest.fn(async (id: string) => { channelCalls.push(id); }),
  };
}

function buildHandler() {
  const foregroundCalls: Array<{ category: NotificationCategory; data: Record<string, string> }> = [];
  const tapCalls: Array<{ category: NotificationCategory; data: Record<string, string> }> = [];

  const handler: INotificationHandler = {
    onForegroundNotification: jest.fn((category, data) => { foregroundCalls.push({ category, data }); }),
    onNotificationTap: jest.fn((category, data) => { tapCalls.push({ category, data }); }),
  };

  return { handler, foregroundCalls, tapCalls };
}

// Mock apiClient at module level
jest.mock('./apiClient', () => ({
  apiClient: {
    post: jest.fn().mockResolvedValue({}),
    get: jest.fn().mockResolvedValue({}),
  },
}));

import { apiClient } from './apiClient';

const ALL_CATEGORIES: NotificationCategory[] = [
  'hazard', 'group_invite', 'group_event', 'rally_point',
  'sos_alert', 'arriving_destination', 'friend_request',
  'gap_alert', 'fuel_suggest',
];

const fcCategory = fc.constantFrom(...ALL_CATEGORIES);

const fcDataRecord = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
  fc.string({ maxLength: 100 }),
  { minKeys: 0, maxKeys: 8 },
);

// ---------------------------------------------------------------------------
// Property 113: registerToken never throws regardless of permission outcome
// ---------------------------------------------------------------------------

describe('Property 113: registerToken never throws regardless of permission outcome', () => {
  it('resolves without throwing for any permission status combination', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('granted', 'denied', 'undetermined'),
        fc.constantFrom('granted', 'denied', 'undetermined'),
        async (existingStatus, requestedStatus) => {
          const provider = buildTokenProvider({ existingStatus, requestedStatus });
          const { handler } = buildHandler();
          const svc = new NotificationService(provider, handler);

          await expect(svc.registerToken()).resolves.toBeUndefined();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('resolves without throwing even when getExpoPushTokenAsync throws', async () => {
    const provider = buildTokenProvider({ existingStatus: 'granted' });
    (provider.getExpoPushTokenAsync as jest.Mock).mockRejectedValue(new Error('Expo token fetch failed'));
    const { handler } = buildHandler();
    const svc = new NotificationService(provider, handler);

    await expect(svc.registerToken()).resolves.toBeUndefined();
  });

  it('resolves without throwing even when setNotificationChannelAsync throws', async () => {
    const provider = buildTokenProvider({ platform: 'android', existingStatus: 'granted' });
    (provider.setNotificationChannelAsync as jest.Mock).mockRejectedValue(new Error('channel error'));
    const { handler } = buildHandler();
    const svc = new NotificationService(provider, handler);

    await expect(svc.registerToken()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 114: registerToken only POSTs token when permission is granted
// ---------------------------------------------------------------------------

describe('Property 114: registerToken only POSTs device token when permission is granted', () => {
  beforeEach(() => {
    (apiClient.post as jest.Mock).mockClear();
  });

  it('does not call apiClient.post when existing permission is denied', async () => {
    const provider = buildTokenProvider({ existingStatus: 'denied', requestedStatus: 'denied' });
    const { handler } = buildHandler();
    const svc = new NotificationService(provider, handler);

    await svc.registerToken();

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('does not call apiClient.post for any non-granted permission outcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('denied', 'undetermined'),
        fc.constantFrom('denied', 'undetermined'),
        async (existingStatus, requestedStatus) => {
          (apiClient.post as jest.Mock).mockClear();
          const provider = buildTokenProvider({ existingStatus, requestedStatus });
          const { handler } = buildHandler();
          const svc = new NotificationService(provider, handler);

          await svc.registerToken();

          expect(apiClient.post).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 10 },
    );
  });

  it('calls apiClient.post exactly once with pushToken and platform when granted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 64 }),
        fc.constantFrom<'ios' | 'android'>('ios', 'android'),
        async (tokenData, platform) => {
          (apiClient.post as jest.Mock).mockClear();
          const provider = buildTokenProvider({ existingStatus: 'granted', tokenData, platform });
          const { handler } = buildHandler();
          const svc = new NotificationService(provider, handler);

          await svc.registerToken();

          expect(apiClient.post).toHaveBeenCalledTimes(1);
          expect(apiClient.post).toHaveBeenCalledWith('/api/v1/devices', { pushToken: tokenData, platform });
        },
      ),
      { numRuns: 20 },
    );
  });

  it('skips requestPermissionsAsync when existing permission is already granted', async () => {
    const provider = buildTokenProvider({ existingStatus: 'granted' });
    const { handler } = buildHandler();
    const svc = new NotificationService(provider, handler);

    await svc.registerToken();

    expect(provider.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Property 115: isRegistered reflects successful registration state
// ---------------------------------------------------------------------------

describe('Property 115: isRegistered reflects successful registration', () => {
  it('is false before any registerToken call', () => {
    const provider = buildTokenProvider({});
    const { handler } = buildHandler();
    const svc = new NotificationService(provider, handler);

    expect(svc.isRegistered).toBe(false);
  });

  it('is true after successful registration for any valid token string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 100 }).filter(s => s.trim().length > 0),
        async (tokenData) => {
          (apiClient.post as jest.Mock).mockResolvedValue({});
          const provider = buildTokenProvider({ existingStatus: 'granted', tokenData });
          const { handler } = buildHandler();
          const svc = new NotificationService(provider, handler);

          await svc.registerToken();

          expect(svc.isRegistered).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('remains false after denied permission', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('denied', 'undetermined'),
        async (existingStatus) => {
          const provider = buildTokenProvider({ existingStatus, requestedStatus: 'denied' });
          const { handler } = buildHandler();
          const svc = new NotificationService(provider, handler);

          await svc.registerToken();

          expect(svc.isRegistered).toBe(false);
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 116: handleForeground and handleTap dispatch exactly what was passed
// ---------------------------------------------------------------------------

describe('Property 116: handleForeground and handleTap are pure dispatchers', () => {
  it('handleForeground passes category and data to handler unchanged', () => {
    fc.assert(
      fc.property(
        fcCategory,
        fcDataRecord,
        (category, data) => {
          const { handler, foregroundCalls } = buildHandler();
          const provider = buildTokenProvider({});
          const svc = new NotificationService(provider, handler);

          svc.handleForeground(category, data);

          expect(foregroundCalls).toHaveLength(1);
          expect(foregroundCalls[0].category).toBe(category);
          expect(foregroundCalls[0].data).toBe(data);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('handleTap passes category and data to handler unchanged', () => {
    fc.assert(
      fc.property(
        fcCategory,
        fcDataRecord,
        (category, data) => {
          const { handler, tapCalls } = buildHandler();
          const provider = buildTokenProvider({});
          const svc = new NotificationService(provider, handler);

          svc.handleTap(category, data);

          expect(tapCalls).toHaveLength(1);
          expect(tapCalls[0].category).toBe(category);
          expect(tapCalls[0].data).toBe(data);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('N sequential handleForeground calls produce exactly N handler invocations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (count) => {
          const { handler, foregroundCalls } = buildHandler();
          const provider = buildTokenProvider({});
          const svc = new NotificationService(provider, handler);

          for (let i = 0; i < count; i++) {
            svc.handleForeground('hazard', { i: String(i) });
          }

          expect(foregroundCalls).toHaveLength(count);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 117: Simulator short-circuit prevents token fetch and API call
// ---------------------------------------------------------------------------

describe('Property 117: Simulator short-circuit prevents any token or API activity', () => {
  it('does not call getExpoPushTokenAsync or apiClient.post when isDevice is false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('granted', 'denied', 'undetermined'),
        async (existingStatus) => {
          (apiClient.post as jest.Mock).mockClear();
          const provider = buildTokenProvider({ isDevice: false, existingStatus });
          const { handler } = buildHandler();
          const svc = new NotificationService(provider, handler);

          await svc.registerToken();

          expect(provider.getExpoPushTokenAsync).not.toHaveBeenCalled();
          expect(apiClient.post).not.toHaveBeenCalled();
          expect(svc.isRegistered).toBe(false);
        },
      ),
      { numRuns: 10 },
    );
  });

  it('does not call getPermissionsAsync when isDevice is false', async () => {
    const provider = buildTokenProvider({ isDevice: false });
    const { handler } = buildHandler();
    const svc = new NotificationService(provider, handler);

    await svc.registerToken();

    expect(provider.getPermissionsAsync).not.toHaveBeenCalled();
  });
});

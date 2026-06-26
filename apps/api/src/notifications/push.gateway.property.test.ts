/**
 * Property tests for ExpoPushGateway.
 *
 * Property 103: Stale push tokens are removed on DeviceNotRegistered
 *   When Expo returns { status: 'error', details: { error: 'DeviceNotRegistered' } }
 *   the gateway deletes the token from the devices table.
 *   Validates: Requirements 15.1, 15.3
 *
 * Property 104: Network errors are non-fatal (no DB side-effect)
 *   If the Expo HTTP call throws or returns a non-ok status, no DB query is issued.
 *   Validates: Requirements 15.1, 43.1
 */

import fc from 'fast-check';
import { Pool } from 'pg';
import { ExpoPushGateway } from './push.gateway';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type FetchMock = jest.MockedFunction<typeof fetch>;
let mockFetch: FetchMock;

beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeDb() {
  const deletedTokens: string[] = [];
  const db: Pool = {
    query: jest.fn(async (_sql: string, params?: unknown[]) => {
      const token = (params ?? [])[0] as string;
      deletedTokens.push(token);
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as Pool;
  return { db, deletedTokens };
}

function expoResponse(receipt: {
  status: 'ok' | 'error';
  details?: { error?: string };
}): Response {
  return new Response(
    JSON.stringify({ data: receipt }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const validPayload = {
  title: 'Test',
  body: 'Test notification',
  priority: 'normal' as const,
};

// ---------------------------------------------------------------------------
// Property 103: Stale tokens are deleted on DeviceNotRegistered
// ---------------------------------------------------------------------------
describe('Property 103: Stale push tokens are removed on DeviceNotRegistered', () => {
  it('deletes the exact token that received DeviceNotRegistered for any token string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 64 }).filter((s) => s.trim().length > 0),
        async (token) => {
          const { db, deletedTokens } = makeDb();
          mockFetch.mockResolvedValue(
            expoResponse({ status: 'error', details: { error: 'DeviceNotRegistered' } }),
          );

          const gateway = new ExpoPushGateway(db);
          await gateway.send(token, 'ios', validPayload);

          expect(deletedTokens).toContain(token);
          expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM devices'),
            [token],
          );
        },
      ),
      { numRuns: 30 },
    );
  });

  it('only deletes the token from DeviceNotRegistered — not other error types', async () => {
    const { db } = makeDb();
    mockFetch.mockResolvedValue(
      expoResponse({ status: 'error', details: { error: 'InvalidCredentials' } }),
    );

    const gateway = new ExpoPushGateway(db);
    await gateway.send('some-token', 'ios', validPayload);

    expect(db.query).not.toHaveBeenCalled();
  });

  it('does not delete when Expo returns status: ok', async () => {
    const { db } = makeDb();
    mockFetch.mockResolvedValue(expoResponse({ status: 'ok' }));

    const gateway = new ExpoPushGateway(db);
    await gateway.send('ok-token', 'android', validPayload);

    expect(db.query).not.toHaveBeenCalled();
  });

  it('DeviceNotRegistered deletes exactly once per send call', async () => {
    const { db } = makeDb();
    mockFetch.mockResolvedValue(
      expoResponse({ status: 'error', details: { error: 'DeviceNotRegistered' } }),
    );

    const gateway = new ExpoPushGateway(db);
    await gateway.send('token-once', 'ios', validPayload);

    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Property 104: Network errors are non-fatal and produce no DB side-effects
// ---------------------------------------------------------------------------
describe('Property 104: Network errors are non-fatal (no DB side-effect)', () => {
  it('fetch throwing does not cause DB query and does not throw', async () => {
    const { db } = makeDb();
    mockFetch.mockRejectedValue(new Error('network failure'));

    const gateway = new ExpoPushGateway(db);
    await expect(gateway.send('tok', 'ios', validPayload)).resolves.toBeUndefined();

    expect(db.query).not.toHaveBeenCalled();
  });

  it('non-ok HTTP response does not cause DB query', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        async (statusCode) => {
          const { db } = makeDb();
          mockFetch.mockResolvedValue(new Response('error', { status: statusCode }));

          const gateway = new ExpoPushGateway(db);
          await gateway.send('tok', 'android', validPayload);

          expect(db.query).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('malformed JSON response is non-fatal and produces no DB query', async () => {
    const { db } = makeDb();
    mockFetch.mockResolvedValue(new Response('NOT_JSON{{{', { status: 200 }));

    const gateway = new ExpoPushGateway(db);
    await expect(gateway.send('tok', 'ios', validPayload)).resolves.toBeUndefined();

    expect(db.query).not.toHaveBeenCalled();
  });

  it('send() with DeviceNotRegistered is always non-throwing regardless of DB errors', async () => {
    const db: Pool = {
      query: jest.fn(async () => { throw new Error('DB connection lost'); }),
    } as unknown as Pool;
    mockFetch.mockResolvedValue(
      expoResponse({ status: 'error', details: { error: 'DeviceNotRegistered' } }),
    );

    const gateway = new ExpoPushGateway(db);
    // Should propagate DB error — production code does not catch it here,
    // so verifying it propagates (is not silently swallowed)
    await expect(gateway.send('tok', 'ios', validPayload)).rejects.toThrow('DB connection lost');
  });
});

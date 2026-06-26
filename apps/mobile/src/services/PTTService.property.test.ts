/**
 * Property tests for PTTService session lifecycle.
 *
 * Property 108: Every holdStart is matched by exactly one holdEnd — no leaked audio sessions
 *   After any sequence of holdStart/holdEnd calls + leaveChannel, muteLocalAudioStream(false)
 *   and muteLocalAudioStream(true) call counts are always equal.
 *   Validates: Requirements 10.1, 10.2, 10.3
 *
 * Property 109: Mute guards unconditionally block holdStart
 *   When selfMuted or adminMuted is true, holdStart never unmutes the microphone or emits
 *   ptt:start regardless of session state.
 *   Validates: Requirements 10.10, 10.11, 10.12
 *
 * Property 110: leaveChannel always terminates active transmission
 *   If transmitting when leaveChannel is called, holdEnd runs first — mic is muted and
 *   ptt:end is emitted before the channel is left. isTransmitting is always false after.
 *   Validates: Requirements 10.3, 10.6
 *
 * Property 111: Socket listeners are registered once and cleaned up on leaveChannel
 *   Multiple joinChannel calls never accumulate duplicate ptt:transmit/ptt:ended listeners.
 *   leaveChannel removes both listeners exactly once.
 *   Validates: Requirements 10.9, 38.3
 *
 * Property 112: setUserVolume scales volumePercent linearly to Agora range [0–400]
 *   For any percent in [0,100], Agora volume = round(percent/100*400).
 *   Values outside [0,100] clamp to 0 or 400. Volume is not applied mid-transmission.
 *   Validates: Requirements 10.8
 */

import fc from 'fast-check';
import { PTTService, IAgoraEngine, ITokenFetcher, IHapticFeedback, PttSessionInfo } from './PTTService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function buildEngine(connected = true) {
  const muteHistory: boolean[] = [];
  const volumeHistory: number[] = [];
  const engine: IAgoraEngine = {
    joinChannel: jest.fn().mockResolvedValue(undefined),
    leaveChannel: jest.fn().mockResolvedValue(undefined),
    muteLocalAudioStream: jest.fn((muted: boolean) => { muteHistory.push(muted); }),
    adjustPlaybackSignalVolume: jest.fn((v: number) => { volumeHistory.push(v); }),
    isConnected: jest.fn(() => connected),
    onTokenPrivilegeWillExpire: jest.fn(),
    destroy: jest.fn(),
  };
  return { engine, muteHistory, volumeHistory };
}

function buildTokenFetcher(): ITokenFetcher {
  return {
    fetchToken: jest.fn().mockResolvedValue({
      token: 'tok', uid: 1, channelName: 'ch', expiresAt: '',
    }),
  };
}

function buildSocket() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

/** Injects a no-op timer so the hold-timer never fires during property runs. */
function noopTimers() {
  const handle = 99 as unknown as ReturnType<typeof setTimeout>;
  return {
    setTimeout_: jest.fn(() => handle) as unknown as typeof setTimeout,
    clearTimeout_: jest.fn() as unknown as typeof clearTimeout,
  };
}

const haptic: IHapticFeedback = { impact: jest.fn() };

const session: PttSessionInfo = { groupId: 'g1', channelId: 'ch1', maxSeconds: 30 };

function makeSvc(connected = true) {
  const { engine, muteHistory, volumeHistory } = buildEngine(connected);
  const socket = buildSocket();
  const { setTimeout_, clearTimeout_ } = noopTimers();
  const svc = new PTTService(engine, buildTokenFetcher(), socket, haptic, setTimeout_, clearTimeout_);
  return { svc, engine, socket, muteHistory, volumeHistory };
}

// ---------------------------------------------------------------------------
// Property 108: Every holdStart is matched by exactly one holdEnd — no leaked audio sessions
// ---------------------------------------------------------------------------

describe('Property 108: Every holdStart is matched by exactly one holdEnd — no leaked audio sessions', () => {
  it('mute(false) and mute(true) call counts balance after any action sequence + leaveChannel', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }),
        async (actions) => {
          const { svc, muteHistory } = makeSvc();
          svc['session'] = session;

          for (const isStart of actions) {
            if (isStart) svc.holdStart();
            else svc.holdEnd();
          }

          await svc.leaveChannel();

          const unmutes = muteHistory.filter((m) => !m).length;
          const mutes = muteHistory.filter((m) => m).length;
          expect(unmutes).toBe(mutes);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('double holdStart is idempotent — only one unmute per transmission window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        (startCount) => {
          const { svc, muteHistory } = makeSvc();
          svc['session'] = session;

          for (let i = 0; i < startCount; i++) svc.holdStart();
          svc.holdEnd();

          expect(muteHistory.filter((m) => !m)).toHaveLength(1);
          expect(muteHistory.filter((m) => m)).toHaveLength(1);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('double holdEnd is idempotent — only one mute per holdEnd', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        (endCount) => {
          const { svc, muteHistory } = makeSvc();
          svc['session'] = session;

          svc.holdStart();
          for (let i = 0; i < endCount; i++) svc.holdEnd();

          expect(muteHistory.filter((m) => !m)).toHaveLength(1);
          expect(muteHistory.filter((m) => m)).toHaveLength(1);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('N start/end pairs produce exactly N unmutes and N mutes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        (pairs) => {
          const { svc, muteHistory } = makeSvc();
          svc['session'] = session;

          for (let i = 0; i < pairs; i++) {
            svc.holdStart();
            svc.holdEnd();
          }

          expect(muteHistory.filter((m) => !m)).toHaveLength(pairs);
          expect(muteHistory.filter((m) => m)).toHaveLength(pairs);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 109: Mute guards unconditionally block holdStart
// ---------------------------------------------------------------------------

describe('Property 109: Mute guards unconditionally block holdStart', () => {
  it('holdStart never unmutes mic when selfMuted or adminMuted', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant([true, false] as [boolean, boolean]),
          fc.constant([false, true] as [boolean, boolean]),
          fc.constant([true, true] as [boolean, boolean]),
        ),
        ([selfMuted, adminMuted]) => {
          const { svc, muteHistory, socket } = makeSvc();
          svc['session'] = session;
          if (selfMuted) svc.setSelfMuted(true);
          if (adminMuted) svc.setAdminMuted(true);

          svc.holdStart();

          expect(muteHistory.filter((m) => !m)).toHaveLength(0);
          const emits = (socket.emit as jest.Mock).mock.calls;
          expect(emits.some(([e]: [string]) => e === 'ptt:start')).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('setSelfMuted(true) during transmission immediately mutes mic and clears isTransmitting', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        (_seed) => {
          const { svc, muteHistory } = makeSvc();
          svc['session'] = session;

          svc.holdStart();
          expect(muteHistory.filter((m) => !m)).toHaveLength(1);

          svc.setSelfMuted(true);

          expect(muteHistory.filter((m) => m)).toHaveLength(1);
          expect(svc['isTransmitting']).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('setAdminMuted(true) during transmission immediately mutes mic and clears isTransmitting', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        (_seed) => {
          const { svc, muteHistory } = makeSvc();
          svc['session'] = session;

          svc.holdStart();
          svc.setAdminMuted(true);

          expect(muteHistory.filter((m) => m)).toHaveLength(1);
          expect(svc['isTransmitting']).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('holdStart after mute removal resumes transmitting normally', () => {
    const { svc, muteHistory } = makeSvc();
    svc['session'] = session;

    svc.setSelfMuted(true);
    svc.holdStart(); // blocked
    expect(muteHistory.filter((m) => !m)).toHaveLength(0);

    svc.setSelfMuted(false);
    svc.holdStart(); // should succeed now
    expect(muteHistory.filter((m) => !m)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Property 110: leaveChannel always terminates active transmission
// ---------------------------------------------------------------------------

describe('Property 110: leaveChannel always terminates active transmission', () => {
  it('leaveChannel mutes mic and emits ptt:end for any maxSeconds when actively transmitting', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 120 }),
        async (maxSeconds) => {
          const { engine, muteHistory } = buildEngine();
          const socket = buildSocket();
          const { setTimeout_, clearTimeout_ } = noopTimers();
          const svc = new PTTService(engine, buildTokenFetcher(), socket, haptic, setTimeout_, clearTimeout_);
          svc['session'] = { groupId: 'g1', channelId: 'ch1', maxSeconds };

          svc.holdStart();
          expect(muteHistory.filter((m) => !m)).toHaveLength(1);

          await svc.leaveChannel();

          expect(muteHistory.filter((m) => m)).toHaveLength(1);
          const emits = (socket.emit as jest.Mock).mock.calls;
          expect(emits.some(([e]: [string]) => e === 'ptt:end')).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('isTransmitting is always false after leaveChannel regardless of prior state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (wasHolding) => {
          const { svc } = makeSvc();
          svc['session'] = session;
          if (wasHolding) svc.holdStart();

          await svc.leaveChannel();

          expect(svc['isTransmitting']).toBe(false);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('leaveChannel while not transmitting does not call muteLocalAudioStream', async () => {
    const { svc, muteHistory } = makeSvc();
    svc['session'] = session;

    await svc.leaveChannel();

    expect(muteHistory).toHaveLength(0);
  });

  it('session is null after leaveChannel — subsequent holdStart is a no-op', async () => {
    const { svc, muteHistory } = makeSvc();
    svc['session'] = session;
    svc.holdStart();

    await svc.leaveChannel();
    muteHistory.length = 0;

    svc.holdStart(); // no session — must return early
    expect(muteHistory).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property 111: Socket listeners registered once, cleaned up on leaveChannel
// ---------------------------------------------------------------------------

describe('Property 111: Socket listeners registered once per session, cleaned up on leaveChannel', () => {
  it('ptt:transmit and ptt:ended each registered exactly once regardless of joinChannel call count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (joinCount) => {
          const { engine } = buildEngine();
          const socket = buildSocket();
          const { setTimeout_, clearTimeout_ } = noopTimers();
          const svc = new PTTService(engine, buildTokenFetcher(), socket, haptic, setTimeout_, clearTimeout_);

          for (let i = 0; i < joinCount; i++) {
            await svc.joinChannel(session);
          }

          const onMock = socket.on as jest.Mock;
          const transmitReg = onMock.mock.calls.filter(([e]: [string]) => e === 'ptt:transmit').length;
          const endedReg = onMock.mock.calls.filter(([e]: [string]) => e === 'ptt:ended').length;
          expect(transmitReg).toBe(1);
          expect(endedReg).toBe(1);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('leaveChannel deregisters ptt:transmit and ptt:ended exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (joinCount) => {
          const { engine } = buildEngine();
          const socket = buildSocket();
          const { setTimeout_, clearTimeout_ } = noopTimers();
          const svc = new PTTService(engine, buildTokenFetcher(), socket, haptic, setTimeout_, clearTimeout_);

          for (let i = 0; i < joinCount; i++) {
            await svc.joinChannel(session);
          }
          await svc.leaveChannel();

          const offMock = socket.off as jest.Mock;
          const transmitDereg = offMock.mock.calls.filter(([e]: [string]) => e === 'ptt:transmit').length;
          const endedDereg = offMock.mock.calls.filter(([e]: [string]) => e === 'ptt:ended').length;
          expect(transmitDereg).toBe(1);
          expect(endedDereg).toBe(1);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('listenersRegistered flag resets after leaveChannel — next joinChannel re-registers once', async () => {
    const { engine } = buildEngine();
    const socket = buildSocket();
    const { setTimeout_, clearTimeout_ } = noopTimers();
    const svc = new PTTService(engine, buildTokenFetcher(), socket, haptic, setTimeout_, clearTimeout_);

    await svc.joinChannel(session);
    await svc.leaveChannel();

    (socket.on as jest.Mock).mockClear();
    await svc.joinChannel(session);

    const onMock = socket.on as jest.Mock;
    expect(onMock.mock.calls.filter(([e]: [string]) => e === 'ptt:transmit')).toHaveLength(1);
    expect(onMock.mock.calls.filter(([e]: [string]) => e === 'ptt:ended')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Property 112: setUserVolume scales volumePercent linearly to Agora range [0–400]
// ---------------------------------------------------------------------------

describe('Property 112: setUserVolume scales volumePercent to Agora range [0–400]', () => {
  it('maps any value in [0,100] to round(v/100*400)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (volumePercent) => {
          const { engine, volumeHistory } = buildEngine();
          const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
          volumeHistory.length = 0;

          svc.setUserVolume(volumePercent);

          const expected = Math.round(volumePercent / 100 * 400);
          expect(volumeHistory.at(-1)).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('clamps values above 100 to Agora volume 400', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 101, max: 1000 }),
        (volumePercent) => {
          const { engine, volumeHistory } = buildEngine();
          const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
          volumeHistory.length = 0;

          svc.setUserVolume(volumePercent);

          expect(volumeHistory.at(-1)).toBe(400);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('clamps values below 0 to Agora volume 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: -1 }),
        (volumePercent) => {
          const { engine, volumeHistory } = buildEngine();
          const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
          volumeHistory.length = 0;

          svc.setUserVolume(volumePercent);

          expect(volumeHistory.at(-1)).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('does not call adjustPlaybackSignalVolume while actively transmitting', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (volumePercent) => {
          const { svc, volumeHistory } = makeSvc();
          svc['session'] = session;

          svc.holdStart();
          const countBefore = volumeHistory.length;

          svc.setUserVolume(volumePercent);

          expect(volumeHistory.length).toBe(countBefore);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('restores to the most-recently-set user volume after holdEnd', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (volumePercent) => {
          const { svc, volumeHistory } = makeSvc();
          svc['session'] = session;

          svc.setUserVolume(volumePercent);
          svc.holdStart();
          volumeHistory.length = 0;
          svc.holdEnd();

          const expected = Math.round(volumePercent / 100 * 400);
          expect(volumeHistory.at(-1)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

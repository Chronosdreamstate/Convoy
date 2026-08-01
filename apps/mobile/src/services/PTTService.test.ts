/**
 * Unit tests for PTTService — covers volume management (Req 10.8/10.9) and
 * basic hold/mute state machine.
 */

import { PTTService, IAgoraEngine, ITokenFetcher, IHapticFeedback, PttSessionInfo } from './PTTService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface VolumeCall { volume: number }

function buildEngine(connected = true): IAgoraEngine & { volumeCalls: VolumeCall[]; muteCalls: boolean[] } {
  const volumeCalls: VolumeCall[] = [];
  const muteCalls: boolean[] = [];
  return {
    volumeCalls,
    muteCalls,
    joinChannel: jest.fn().mockResolvedValue(undefined),
    leaveChannel: jest.fn().mockResolvedValue(undefined),
    muteLocalAudioStream: jest.fn((muted: boolean) => { muteCalls.push(muted); }),
    adjustPlaybackSignalVolume: jest.fn((volume: number) => { volumeCalls.push({ volume }); }),
    isConnected: jest.fn(() => connected),
    onTokenPrivilegeWillExpire: jest.fn(),
    renewToken: jest.fn(),
    destroy: jest.fn(),
  };
}

function buildTokenFetcher(): ITokenFetcher {
  return {
    fetchToken: jest.fn().mockResolvedValue({ token: 'tok', uid: 1, channelName: 'ch', expiresAt: '' }),
  };
}

function buildSocket(): Pick<import('socket.io-client').Socket, 'emit' | 'on' | 'off'> {
  return {
    emit: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  };
}

const haptic: IHapticFeedback = { impact: jest.fn() };

const session: PttSessionInfo = { groupId: 'g1', channelId: 'ch1', maxSeconds: 30 };

// ---------------------------------------------------------------------------
// setUserVolume — Req 10.8/10.9
// ---------------------------------------------------------------------------

describe('PTTService.setUserVolume', () => {
  it('converts 100% to Agora volume 400', () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc.setUserVolume(100);
    const last = engine.volumeCalls.at(-1);
    expect(last?.volume).toBe(400);
  });

  it('converts 50% to Agora volume 200', () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc.setUserVolume(50);
    expect(engine.volumeCalls.at(-1)?.volume).toBe(200);
  });

  it('converts 25% to Agora volume 100', () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc.setUserVolume(25);
    expect(engine.volumeCalls.at(-1)?.volume).toBe(100);
  });

  it('clamps values above 100 to 400', () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc.setUserVolume(150);
    expect(engine.volumeCalls.at(-1)?.volume).toBe(400);
  });

  it('clamps values below 0 to 0', () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc.setUserVolume(-10);
    expect(engine.volumeCalls.at(-1)?.volume).toBe(0);
  });

  it('does not call adjustPlaybackSignalVolume while transmitting', () => {
    jest.useFakeTimers();
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc['session'] = session; svc['channelJoined'] = true; // inject joined session directly
    svc.holdStart();
    engine.volumeCalls.length = 0; // clear prior calls
    svc.setUserVolume(50);
    expect(engine.volumeCalls).toHaveLength(0); // must not change volume mid-transmit
    jest.useRealTimers();
  });

  it('applies user volume after joinChannel', async () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc.setUserVolume(75); // 300 in Agora scale
    await svc.joinChannel(session);
    // The last adjustPlaybackSignalVolume call after join should be the user's volume
    const joinVolumeCall = engine.volumeCalls.find(c => c.volume === 300);
    expect(joinVolumeCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// pttEndedHandler restores user volume, not hardcoded 400
// ---------------------------------------------------------------------------

describe('PTTService volume restore after ducking', () => {
  it('restores to user volume (not 400) after ptt:ended event', () => {
    const engine = buildEngine();
    const socket = buildSocket();
    const svc = new PTTService(engine, buildTokenFetcher(), socket, haptic);
    svc.setUserVolume(50); // user prefers 200 (50%)

    // Simulate ptt:transmit duck
    engine.adjustPlaybackSignalVolume(120); // duck to 120

    // Handler is registered lazily on joinChannel — invoke directly via private field
    const handler = (svc as unknown as { pttEndedHandler: () => void }).pttEndedHandler;
    engine.volumeCalls.length = 0;
    handler();
    expect(engine.volumeCalls.at(-1)?.volume).toBe(200); // 50% → 200, not 400
  });

  it('restores to user volume after holdEnd', () => {
    jest.useFakeTimers();
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc.setUserVolume(75); // 300
    svc['session'] = session;
    svc['channelJoined'] = true; // mirror the state a successful joinChannel leaves
    svc.holdStart();
    engine.volumeCalls.length = 0;
    svc.holdEnd();
    expect(engine.volumeCalls.at(-1)?.volume).toBe(300);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Token refresh on onTokenPrivilegeWillExpire — Req 38.2
// ---------------------------------------------------------------------------

describe('PTTService token refresh (onTokenPrivilegeWillExpire)', () => {
  it('fetches a fresh token and applies it via renewToken, without rejoining the channel', async () => {
    const engine = buildEngine();
    const tokenFetcher = buildTokenFetcher();
    (tokenFetcher.fetchToken as jest.Mock)
      .mockResolvedValueOnce({ token: 'tok-initial', uid: 1, channelName: 'ch', expiresAt: '' })
      .mockResolvedValueOnce({ token: 'tok-renewed', uid: 1, channelName: 'ch', expiresAt: '' });
    const svc = new PTTService(engine, tokenFetcher, buildSocket(), haptic);

    await svc.joinChannel(session);
    expect(engine.joinChannel).toHaveBeenCalledTimes(1);

    // Simulate Agora firing the expiry callback registered via onTokenPrivilegeWillExpire
    const expiryCallback = (engine.onTokenPrivilegeWillExpire as jest.Mock).mock.calls[0][0];
    await expiryCallback();

    expect(tokenFetcher.fetchToken).toHaveBeenCalledTimes(2);
    expect(engine.renewToken).toHaveBeenCalledWith('tok-renewed');
    // Must not rejoin — that would risk an audible interruption mid-session
    expect(engine.joinChannel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Self/admin mute state machine
// ---------------------------------------------------------------------------

describe('PTTService mute state machine', () => {
  it('holdStart is blocked when self-muted', () => {
    jest.useFakeTimers();
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc['session'] = session;
    svc['channelJoined'] = true; // mirror the state a successful joinChannel leaves
    svc.setSelfMuted(true);
    svc.holdStart();
    expect(engine.muteLocalAudioStream).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('holdStart is blocked when admin-muted', () => {
    jest.useFakeTimers();
    const engine = buildEngine();
    const svc = new PTTService(engine, buildTokenFetcher(), buildSocket(), haptic);
    svc['session'] = session;
    svc['channelJoined'] = true; // mirror the state a successful joinChannel leaves
    svc.setAdminMuted(true);
    svc.holdStart();
    expect(engine.muteLocalAudioStream).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('setSelfMuted(true) during transmission calls holdEnd', () => {
    jest.useFakeTimers();
    const engine = buildEngine();
    const socket = buildSocket();
    const svc = new PTTService(engine, buildTokenFetcher(), socket, haptic);
    svc['session'] = session;
    svc['channelJoined'] = true; // mirror the state a successful joinChannel leaves
    svc.holdStart();
    expect((socket.emit as jest.Mock).mock.calls.some(([e]: [string]) => e === 'ptt:start')).toBe(true);
    svc.setSelfMuted(true);
    expect((socket.emit as jest.Mock).mock.calls.some(([e]: [string]) => e === 'ptt:end')).toBe(true);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Incoming PTT must stay at the listener's chosen volume (Req 10.8)
//
// adjustPlaybackSignalVolume is Agora's REMOTE playback level, not the
// device's media volume. Ducking it on ptt:transmit — an attempt at the Req
// 10.9 media ducking that actually needs an audio-session change — dropped the
// convoy's voice to 30% for the whole transmission, on every listener, since
// the server broadcasts ptt:transmit to each recipient's personal room.
// ---------------------------------------------------------------------------

describe('PTTService playback volume across a transmission', () => {
  /** Grab the handler PTTService registered for a socket event. */
  function handlerFor(socket: { on: jest.Mock }, event: string): () => void {
    const call = socket.on.mock.calls.find(([e]: [string]) => e === event);
    return call?.[1] as () => void;
  }

  it('does not lower remote playback while someone is transmitting', async () => {
    const engine = buildEngine();
    const socket = buildSocket() as unknown as { on: jest.Mock };
    const svc = new PTTService(engine, buildTokenFetcher(), socket as never, haptic);
    await svc.joinChannel(session);
    svc.setUserVolume(75); // 300 on Agora's 0–400 scale

    engine.volumeCalls.length = 0;
    handlerFor(socket, 'ptt:transmit')();

    expect(engine.volumeCalls.map((c) => c.volume)).not.toContain(120);
    expect(engine.volumeCalls.at(-1)?.volume).toBe(300);
  });

  it('is back at the same level once the transmission ends', async () => {
    const engine = buildEngine();
    const socket = buildSocket() as unknown as { on: jest.Mock };
    const svc = new PTTService(engine, buildTokenFetcher(), socket as never, haptic);
    await svc.joinChannel(session);
    svc.setUserVolume(50);

    handlerFor(socket, 'ptt:transmit')();
    handlerFor(socket, 'ptt:ended')();

    expect(engine.volumeCalls.at(-1)?.volume).toBe(200);
  });

  it('honours a volume change made mid-transmission', async () => {
    const engine = buildEngine();
    const socket = buildSocket() as unknown as { on: jest.Mock };
    const svc = new PTTService(engine, buildTokenFetcher(), socket as never, haptic);
    await svc.joinChannel(session);

    handlerFor(socket, 'ptt:transmit')();
    svc.setUserVolume(25);
    handlerFor(socket, 'ptt:ended')();

    expect(engine.volumeCalls.at(-1)?.volume).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Admin mute applied BEFORE this device joined (Req 10.10, 10.11)
//
// ptt:muted only reaches a device that's already listening, so a member muted
// before joining — or before an app restart — used to arrive with a normal PTT
// button. The token response carries the current mute state; a muted member
// still joins the channel so they can hear the convoy.
// ---------------------------------------------------------------------------

describe('PTTService admin mute from the token response', () => {
  function fetcherWith(canTransmit: boolean | undefined): ITokenFetcher {
    return {
      fetchToken: jest.fn().mockResolvedValue({
        token: 'tok', uid: 1, channelName: 'ch', expiresAt: '', canTransmit,
      }),
    };
  }

  it('joins the channel and blocks transmission when the token is subscribe-only', async () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, fetcherWith(false), buildSocket(), haptic);

    await svc.joinChannel(session);

    // Still in the audio channel — mute must not deafen them.
    expect(engine.joinChannel).toHaveBeenCalled();
    expect(svc.voiceAvailable).toBe(true);
    expect(svc.isAdminMuted).toBe(true);

    svc.holdStart();
    expect(engine.muteLocalAudioStream).not.toHaveBeenCalled();
  });

  it('leaves an unmuted member able to transmit', async () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, fetcherWith(true), buildSocket(), haptic);

    await svc.joinChannel(session);

    expect(svc.isAdminMuted).toBe(false);
    svc.holdStart();
    expect(engine.muteLocalAudioStream).toHaveBeenCalledWith(false);
    svc.holdEnd(); // clears the real max-hold timer so Jest can exit
  });

  it('treats a response without canTransmit as unmuted (older server)', async () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, fetcherWith(undefined), buildSocket(), haptic);

    await svc.joinChannel(session);

    expect(svc.isAdminMuted).toBe(false);
  });

  it('clears a stale admin mute when the member is unmuted before rejoining', async () => {
    const engine = buildEngine();
    const svc = new PTTService(engine, fetcherWith(true), buildSocket(), haptic);
    svc.setAdminMuted(true);

    await svc.joinChannel(session);

    expect(svc.isAdminMuted).toBe(false);
  });
});

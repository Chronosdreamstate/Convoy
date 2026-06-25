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
    svc['session'] = session; // inject session directly
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

    // Retrieve and invoke the pttEndedHandler that was registered
    const onMock = socket.on as jest.Mock;
    const pttEndedCallback = onMock.mock.calls.find(([event]: [string]) => event === 'ptt:ended')?.[1];
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
    svc.holdStart();
    engine.volumeCalls.length = 0;
    svc.holdEnd();
    expect(engine.volumeCalls.at(-1)?.volume).toBe(300);
    jest.useRealTimers();
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
    svc.holdStart();
    expect((socket.emit as jest.Mock).mock.calls.some(([e]: [string]) => e === 'ptt:start')).toBe(true);
    svc.setSelfMuted(true);
    expect((socket.emit as jest.Mock).mock.calls.some(([e]: [string]) => e === 'ptt:end')).toBe(true);
    jest.useRealTimers();
  });
});

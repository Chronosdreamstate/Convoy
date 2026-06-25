/**
 * PTTService — wraps Agora RTC SDK for push-to-talk audio.
 * Requirements: 10.1–10.13, 38.2, 38.3, 39.2, 43.3
 */

import type { Socket } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Injectable interfaces (Agora SDK + token fetcher)
// ---------------------------------------------------------------------------

export interface IAgoraEngine {
  joinChannel(token: string, channelName: string, uid: number): Promise<void>;
  leaveChannel(): Promise<void>;
  muteLocalAudioStream(muted: boolean): void;
  adjustPlaybackSignalVolume(volume: number): void; // 0–400
  isConnected(): boolean;
  onTokenPrivilegeWillExpire(callback: () => void): void;
  destroy(): void;
}

export interface ITokenFetcher {
  fetchToken(groupId: string, channelId: string): Promise<{
    token: string;
    uid: number;
    channelName: string;
    expiresAt: string;
  }>;
}

export interface IHapticFeedback {
  impact(): void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PttSessionInfo {
  groupId: string;
  channelId: string;
  maxSeconds: number;
}

// ---------------------------------------------------------------------------
// PTTService
// ---------------------------------------------------------------------------

const DUCK_VOLUME = 120; // 30% of 400 max
const FULL_VOLUME = 400;

export class PTTService {
  private session: PttSessionInfo | null = null;
  private currentLogId: string | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private selfMuted = false;
  private adminMuted = false;
  private isTransmitting = false;
  private listenersRegistered = false;
  private expiryListenerRegistered = false;

  private readonly pttTransmitHandler = () => {
    this.engine.adjustPlaybackSignalVolume(DUCK_VOLUME);
  };
  private readonly pttEndedHandler = () => {
    this.engine.adjustPlaybackSignalVolume(FULL_VOLUME);
  };

  constructor(
    private readonly engine: IAgoraEngine,
    private readonly tokenFetcher: ITokenFetcher,
    private readonly socket: Pick<Socket, 'emit' | 'on' | 'off'>,
    private readonly haptic: IHapticFeedback,
    private readonly setTimeout_: typeof setTimeout = setTimeout,
    private readonly clearTimeout_: typeof clearTimeout = clearTimeout,
  ) {}

  /** Join a group's PTT channel. Fetches token from API. */
  async joinChannel(session: PttSessionInfo): Promise<void> {
    this.session = session;
    const { groupId, channelId } = session;

    if (!this.engine.isConnected()) return; // degraded mode (Req 43.3)

    const { token, uid, channelName } = await this.tokenFetcher.fetchToken(groupId, channelId);

    await this.engine.joinChannel(token, channelName, uid);

    // Auto-refresh before expiry (Req 38.2) — register only once to prevent accumulation
    if (!this.expiryListenerRegistered) {
      this.engine.onTokenPrivilegeWillExpire(async () => {
        if (!this.session) return;
        const refreshed = await this.tokenFetcher.fetchToken(groupId, channelId);
        await this.engine.joinChannel(refreshed.token, refreshed.channelName, refreshed.uid);
      });
      this.expiryListenerRegistered = true;
    }

    // Listen for ptt:transmit to apply media ducking (Req 10.9)
    if (!this.listenersRegistered) {
      this.socket.on('ptt:transmit', this.pttTransmitHandler);
      this.socket.on('ptt:ended', this.pttEndedHandler);
      this.listenersRegistered = true;
    }
  }

  /** Called on PTT button hold-start. */
  holdStart(): void {
    if (!this.session) return;
    if (this.selfMuted || this.adminMuted) return; // Req 10.10, 10.11
    if (!this.engine.isConnected()) return; // Req 43.3
    if (this.isTransmitting) return;

    this.isTransmitting = true;
    this.haptic.impact(); // Req 39.2

    this.engine.muteLocalAudioStream(false);

    this.socket.emit('ptt:start', { channelId: this.session.channelId });

    // Server-side max enforced too; client timer as belt-and-braces (Req 10.5)
    this.holdTimer = this.setTimeout_(() => {
      this.holdEnd();
    }, this.session.maxSeconds * 1000);
  }

  /** Called on PTT button release (or timer expiry). */
  holdEnd(): void {
    if (!this.isTransmitting) return;
    this.isTransmitting = false;

    if (this.holdTimer !== null) {
      this.clearTimeout_(this.holdTimer);
      this.holdTimer = null;
    }

    this.engine.muteLocalAudioStream(true);
    this.engine.adjustPlaybackSignalVolume(FULL_VOLUME);

    // Send end event even without a server-assigned logId (channel fallback)
    this.socket.emit('ptt:end', {
      logId: this.currentLogId ?? undefined,
      channelId: this.session?.channelId,
    });
    this.currentLogId = null;
  }

  /** Records the logId returned by the server's ptt:transmit event. */
  setCurrentLogId(logId: string): void {
    this.currentLogId = logId;
  }

  /** Toggle self-mute (Req 10.12). */
  setSelfMuted(muted: boolean): void {
    this.selfMuted = muted;
    if (muted && this.isTransmitting) this.holdEnd();
  }

  /** Honour admin-imposed mute (Req 10.10, 10.11). */
  setAdminMuted(muted: boolean): void {
    this.adminMuted = muted;
    if (muted && this.isTransmitting) this.holdEnd();
  }

  /** Adjust PTT receive volume (0–400). */
  setPlaybackVolume(volume: number): void {
    this.engine.adjustPlaybackSignalVolume(Math.max(0, Math.min(400, volume)));
  }

  /** Leave the PTT channel and clean up. */
  async leaveChannel(): Promise<void> {
    if (this.isTransmitting) this.holdEnd();
    this.session = null;
    this.expiryListenerRegistered = false; // reset so next joinChannel re-registers for the new session
    await this.engine.leaveChannel();
    if (this.listenersRegistered) {
      this.socket.off('ptt:transmit', this.pttTransmitHandler);
      this.socket.off('ptt:ended', this.pttEndedHandler);
      this.listenersRegistered = false;
    }
  }

  get voiceAvailable(): boolean {
    return this.engine.isConnected();
  }
}

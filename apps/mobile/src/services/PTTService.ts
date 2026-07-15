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
  /** Applies a freshly-fetched token to the live session without leaving/rejoining the channel. */
  renewToken(token: string): void;
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

/** Retry cadence for a failed channel join (e.g. token fetch while offline). */
export const REJOIN_DELAY_MS = 10_000;

export class PTTService {
  private session: PttSessionInfo | null = null;
  private currentLogId: string | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private selfMuted = false;
  private adminMuted = false;
  private isTransmitting = false;
  private channelJoined = false;
  private listenersRegistered = false;
  private expiryListenerRegistered = false;
  private userVolume = FULL_VOLUME; // reflects user's pttVolumePercent setting (0–400)

  private readonly pttTransmitHandler = () => {
    this.engine.adjustPlaybackSignalVolume(DUCK_VOLUME);
  };
  private readonly pttEndedHandler = () => {
    this.engine.adjustPlaybackSignalVolume(this.userVolume);
  };

  constructor(
    private readonly engine: IAgoraEngine,
    private readonly tokenFetcher: ITokenFetcher,
    private readonly socket: Pick<Socket, 'emit' | 'on' | 'off'>,
    private readonly haptic: IHapticFeedback,
    private readonly setTimeout_: typeof setTimeout = setTimeout,
    private readonly clearTimeout_: typeof clearTimeout = clearTimeout,
  ) {}

  /**
   * Join a group's PTT channel. Fetches token from API.
   *
   * Never rejects: a failed token fetch / engine join (e.g. the app came up
   * offline) marks the session unjoined, schedules a retry, and leaves
   * `voiceAvailable` false so the UI shows "Voice unavailable" (Req 43.3) —
   * previously the rejection was unhandled and PTT stayed silently dead for
   * the entire session even after connectivity returned.
   */
  async joinChannel(session: PttSessionInfo): Promise<void> {
    this.session = session;
    this.channelJoined = false;
    const { groupId, channelId } = session;

    if (!this.engine.isConnected()) return; // degraded mode (Req 43.3)

    try {
      const { token, uid, channelName } = await this.tokenFetcher.fetchToken(groupId, channelId);
      // Session may have changed while the fetch was in flight (leave/rejoin race)
      if (this.session !== session) return;
      await this.engine.joinChannel(token, channelName, uid);
      this.channelJoined = true;
    } catch (err) {
      console.warn('[PTTService] PTT channel join failed — retrying:', err);
      this.scheduleRejoin();
      return;
    }
    this.engine.adjustPlaybackSignalVolume(this.userVolume);

    // Auto-refresh before expiry (Req 38.2) — register only once to prevent accumulation.
    // Uses renewToken() rather than rejoining the channel so a live PTT session isn't
    // interrupted (rejoin would briefly drop the audio connection).
    if (!this.expiryListenerRegistered) {
      this.engine.onTokenPrivilegeWillExpire(async () => {
        // Read the session at fire time (not via closure captures) so the
        // refresh always targets the CURRENT channel across join/leave cycles.
        const current = this.session;
        if (!current) return;
        try {
          const refreshed = await this.tokenFetcher.fetchToken(current.groupId, current.channelId);
          // Session may have changed while the fetch was in flight — don't
          // apply a token for a channel we already left.
          if (this.session?.channelId !== current.channelId) return;
          this.engine.renewToken(refreshed.token);
        } catch (err) {
          // Refresh failure is non-fatal here: Agora fires this callback ~30s
          // before expiry and will retry; worst case the channel drops and the
          // next joinChannel() fetches a fresh token.
          console.warn('[PTTService] PTT token refresh failed:', err);
        }
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

  /** Re-attempts joinChannel after a failed join, once per REJOIN_DELAY_MS. */
  private scheduleRejoin(): void {
    if (this.rejoinTimer !== null) return;
    this.rejoinTimer = this.setTimeout_(() => {
      this.rejoinTimer = null;
      const current = this.session;
      if (!current || this.channelJoined) return;
      void this.joinChannel(current);
    }, REJOIN_DELAY_MS);
  }

  /** Called on PTT button hold-start. */
  holdStart(): void {
    if (!this.session) return;
    if (this.selfMuted || this.adminMuted) return; // Req 10.10, 10.11
    if (!this.engine.isConnected()) return; // Req 43.3
    // Not actually in the Agora channel (join failed / still retrying) — a
    // transmit here would signal ptt:start to the group while nobody can hear
    // any audio (Req 43.3: disable rather than silently fail).
    if (!this.channelJoined) return;
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
    this.engine.adjustPlaybackSignalVolume(this.userVolume);

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

  /**
   * Updates the max hold duration for future transmissions (Req 10.6) — e.g. when the
   * Admin changes the group's PTT limit mid-session. Does not retroactively shorten a
   * transmission already in progress; takes effect on the next holdStart().
   */
  setMaxSeconds(maxSeconds: number): void {
    if (this.session) this.session.maxSeconds = maxSeconds;
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

  /** Apply user's volume preference (0–100 percent scale). Updates stored level and Agora immediately. */
  setUserVolume(volumePercent: number): void {
    this.userVolume = Math.round(Math.max(0, Math.min(100, volumePercent)) / 100 * 400);
    if (!this.isTransmitting) {
      this.engine.adjustPlaybackSignalVolume(this.userVolume);
    }
  }

  /** Adjust PTT receive volume (0–400). */
  setPlaybackVolume(volume: number): void {
    this.engine.adjustPlaybackSignalVolume(Math.max(0, Math.min(400, volume)));
  }

  /** Leave the PTT channel and clean up. */
  async leaveChannel(): Promise<void> {
    if (this.isTransmitting) this.holdEnd();
    this.session = null;
    this.channelJoined = false;
    if (this.rejoinTimer !== null) {
      this.clearTimeout_(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    this.expiryListenerRegistered = false; // reset so next joinChannel re-registers for the new session
    await this.engine.leaveChannel();
    if (this.listenersRegistered) {
      this.socket.off('ptt:transmit', this.pttTransmitHandler);
      this.socket.off('ptt:ended', this.pttEndedHandler);
      this.listenersRegistered = false;
    }
  }

  get voiceAvailable(): boolean {
    // With an active session, "available" means actually joined to the Agora
    // channel — a failed join (offline token fetch) must surface the "Voice
    // unavailable" indicator instead of a PTT button that silently does
    // nothing (Req 43.3). Without a session, engine readiness is the signal.
    if (!this.engine.isConnected()) return false;
    return this.session === null || this.channelJoined;
  }
}

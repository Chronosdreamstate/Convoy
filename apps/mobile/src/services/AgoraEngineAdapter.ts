/**
 * AgoraEngineAdapter — wraps react-native-agora behind the IAgoraEngine
 * interface so PTTService stays decoupled from the SDK.
 *
 * Uses a lazy require() so the app doesn't crash if react-native-agora is not
 * yet installed. In that case PTT runs in socket-only mode (no voice).
 *
 * Install: npx expo install react-native-agora
 * Env var: EXPO_PUBLIC_AGORA_APP_ID
 */

import { Platform, PermissionsAndroid } from 'react-native';
import type { IAgoraEngine } from './PTTService';

const APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID ?? '';

async function requestMicPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: 'Microphone Access',
        message: 'CONVOY needs microphone access for push-to-talk.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      },
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

class AgoraEngineAdapter implements IAgoraEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private engine: any = null;
  private _initialized = false;
  private tokenExpiryCb: (() => void) | null = null;

  constructor() {
    if (!APP_ID) {
      console.warn('[PTT] EXPO_PUBLIC_AGORA_APP_ID not set — voice disabled');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Agora = require('react-native-agora');
      this.engine = Agora.createAgoraRtcEngine();
      this.engine.initialize({ appId: APP_ID });
      this.engine.enableAudio();
      // Default muted: only unmute while PTT button is held
      this.engine.muteLocalAudioStream(true);
      this._initialized = true;

      this.engine.addListener('onTokenPrivilegeWillExpire', () => {
        this.tokenExpiryCb?.();
      });
      this.engine.addListener('onError', (errCode: number) => {
        console.warn('[Agora] error code:', errCode);
      });
    } catch {
      console.warn('[PTT] react-native-agora not installed — voice disabled');
    }
  }

  async joinChannel(token: string, channelName: string, uid: number): Promise<void> {
    if (!this.engine) return;
    const hasPerm = await requestMicPermission();
    if (!hasPerm) return;

    this.engine.joinChannel(token, channelName, uid, {
      clientRoleType: 1,            // ClientRoleBroadcaster
      publishMicrophoneTrack: false, // start muted; unmuted on hold
      autoSubscribeAudio: true,
    });
    // Yield a tick so Agora begins its async connection handshake
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  async leaveChannel(): Promise<void> {
    if (!this.engine) return;
    this.engine.leaveChannel();
  }

  muteLocalAudioStream(muted: boolean): void {
    this.engine?.muteLocalAudioStream(muted);
  }

  adjustPlaybackSignalVolume(volume: number): void {
    // Agora accepts 0–400
    this.engine?.adjustPlaybackSignalVolume(volume);
  }

  /**
   * Returns true when the Agora SDK is initialised and ready to join channels.
   * PTTService calls this before joining (degraded-mode check, Req 43.3) and
   * before each holdStart (to skip transmit when audio is unavailable).
   */
  isConnected(): boolean {
    return this._initialized;
  }

  onTokenPrivilegeWillExpire(callback: () => void): void {
    this.tokenExpiryCb = callback;
  }

  destroy(): void {
    this.engine?.release();
    this.engine = null;
    this._initialized = false;
  }
}

// Singleton — Agora docs recommend one engine instance per app lifecycle
export const agoraEngineAdapter = new AgoraEngineAdapter();

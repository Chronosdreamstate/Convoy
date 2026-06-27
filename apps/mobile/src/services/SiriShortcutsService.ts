import { NativeModules, Platform } from 'react-native';

const { ConvoySiriShortcuts } = NativeModules;

export type SiriShortcutAction =
  | 'start_convoy'
  | 'join_convoy'
  | 'ptt_transmit'
  | 'navigate_to_group'
  | 'check_gap';

export interface SiriShortcut {
  action: SiriShortcutAction;
  title: string;
  suggestedInvocationPhrase: string;
  persistentIdentifier: string;
}

const SHORTCUTS: SiriShortcut[] = [
  {
    action: 'start_convoy',
    title: 'Start a Convoy',
    suggestedInvocationPhrase: 'Start my convoy',
    persistentIdentifier: 'com.convoy.startConvoy',
  },
  {
    action: 'join_convoy',
    title: 'Join my Convoy',
    suggestedInvocationPhrase: 'Join convoy',
    persistentIdentifier: 'com.convoy.joinConvoy',
  },
  {
    action: 'ptt_transmit',
    title: 'Push to Talk',
    suggestedInvocationPhrase: 'Convoy radio',
    persistentIdentifier: 'com.convoy.ptt',
  },
  {
    action: 'check_gap',
    title: 'Check my gap',
    suggestedInvocationPhrase: 'Check my gap distance',
    persistentIdentifier: 'com.convoy.checkGap',
  },
];

// TODO: Implement native ConvoyLiveActivity module in ios/
// Required: SiriKit/Intents + NSUserActivity donation
// See: https://developer.apple.com/documentation/sirikit/shortcut

export const SiriShortcutsService = {
  isAvailable(): boolean {
    return Platform.OS === 'ios' && !!ConvoySiriShortcuts;
  },

  async donateShortcut(action: SiriShortcutAction): Promise<void> {
    if (!this.isAvailable()) return;
    const shortcut = SHORTCUTS.find((s) => s.action === action);
    if (!shortcut) return;
    try {
      await ConvoySiriShortcuts.donateShortcut(shortcut);
    } catch { /* native module not yet implemented */ }
  },

  async donateAll(): Promise<void> {
    for (const shortcut of SHORTCUTS) {
      await this.donateShortcut(shortcut.action);
    }
  },

  async deleteShortcut(persistentIdentifier: string): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await ConvoySiriShortcuts.deleteShortcut(persistentIdentifier);
    } catch { /* native module not yet implemented */ }
  },
};

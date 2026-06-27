import { NativeModules, Platform } from 'react-native';

// iOS Live Activities (Dynamic Island + Lock Screen) for convoy status.
// Requires native ActivityKit implementation in ios/ target.
// TODO: Implement native ConvoyLiveActivity module in ios/
//   Required: ActivityKit framework, WidgetKit extension target
//   See: https://developer.apple.com/documentation/activitykit

const { ConvoyLiveActivity } = NativeModules;

export interface ConvoyActivityState {
  groupName: string;
  memberCount: number;
  myPosition: number;
  totalCars: number;
  gapToCarAheadM: number | null;
  transmittingCallsign: string | null;
  isLeadCar: boolean;
}

export const LiveActivityService = {
  isAvailable(): boolean {
    return Platform.OS === 'ios' && !!ConvoyLiveActivity;
  },

  async startActivity(state: ConvoyActivityState): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await ConvoyLiveActivity.startActivity(state);
    } catch {
      // Native module not yet implemented — no-op until ios/ target is added
    }
  },

  async updateActivity(state: Partial<ConvoyActivityState>): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await ConvoyLiveActivity.updateActivity(state);
    } catch {
      // no-op
    }
  },

  async endActivity(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await ConvoyLiveActivity.endActivity();
    } catch {
      // no-op
    }
  },
};

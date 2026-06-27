import { NativeModules, Platform } from 'react-native';

interface ConvoyWidgetData {
  isInConvoy: boolean;
  groupName: string | null;
  positionInConvoy: number | null;
  totalCars: number | null;
  gapToCarAheadM: number | null;
  speedKph: number | null;
  lastUpdated: string; // ISO
}

const { ConvoyWidget } = NativeModules;

export const WidgetKitService = {
  isAvailable(): boolean {
    return Platform.OS === 'ios' && !!ConvoyWidget;
  },

  async updateWidget(data: ConvoyWidgetData): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await ConvoyWidget.updateWidgetData(JSON.stringify(data));
    } catch { /* native module not yet implemented */ }
  },

  async clearWidget(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await ConvoyWidget.clearWidgetData();
    } catch { /* no-op */ }
  },
};

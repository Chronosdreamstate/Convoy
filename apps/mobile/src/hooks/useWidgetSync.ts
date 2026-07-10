import { useEffect, useRef } from 'react';
import { useGroupStore } from '../stores/groupStore';
import { useLocationStore } from '../stores/locationStore';
import { WidgetKitService } from '../services/WidgetKitService';

// Syncs convoy state to the iOS widget every 30s while in a convoy
export function useWidgetSync() {
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const groupName = useGroupStore((s) => s.name ?? null);
  const speedKph = useLocationStore((s) => s.myLocation?.speedKph ?? null);

  // Latest values are read through a ref so the interval below survives GPS
  // updates. Previously speedKph was an effect dependency, which tore down and
  // recreated the interval (and cleared the widget) on every location tick —
  // the 30s timer never actually fired.
  const latest = useRef({ activeGroupId, groupName, speedKph });
  latest.current = { activeGroupId, groupName, speedKph };

  useEffect(() => {
    if (!WidgetKitService.isAvailable()) return;

    const sync = () => {
      const current = latest.current;
      void WidgetKitService.updateWidget({
        isInConvoy: !!current.activeGroupId,
        groupName: current.groupName,
        positionInConvoy: null,
        totalCars: null,
        gapToCarAheadM: null,
        speedKph: current.speedKph,
        lastUpdated: new Date().toISOString(),
      });
    };

    sync();
    const interval = setInterval(sync, 30_000);
    return () => {
      clearInterval(interval);
      void WidgetKitService.clearWidget();
    };
    // Only convoy membership changes should reset the sync loop.
  }, [activeGroupId]);
}

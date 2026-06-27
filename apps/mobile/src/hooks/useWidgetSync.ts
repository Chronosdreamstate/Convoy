import { useEffect } from 'react';
import { useGroupStore } from '../stores/groupStore';
import { useLocationStore } from '../stores/locationStore';
import { WidgetKitService } from '../services/WidgetKitService';

// Syncs convoy state to the iOS widget every 30s while in a convoy
export function useWidgetSync() {
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const groupName = useGroupStore((s) => s.name ?? null);
  const speedKph = useLocationStore((s) => s.myLocation?.speedKph ?? null);

  useEffect(() => {
    if (!WidgetKitService.isAvailable()) return;

    const sync = () => {
      void WidgetKitService.updateWidget({
        isInConvoy: !!activeGroupId,
        groupName,
        positionInConvoy: null,
        totalCars: null,
        gapToCarAheadM: null,
        speedKph,
        lastUpdated: new Date().toISOString(),
      });
    };

    sync();
    const interval = setInterval(sync, 30_000);
    return () => {
      clearInterval(interval);
      void WidgetKitService.clearWidget();
    };
  }, [activeGroupId, groupName, speedKph]);
}

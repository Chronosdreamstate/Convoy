import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useAccessibilitySettings() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [screenReaderActive, setScreenReaderActive] = useState(false);
  const [boldText, setBoldText] = useState(false);

  useEffect(() => {
    // .catch: these can reject on platforms lacking the capability — an
    // accessibility probe failure must never surface as an unhandled rejection.
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    AccessibilityInfo.isScreenReaderEnabled().then(setScreenReaderActive).catch(() => {});
    (AccessibilityInfo.isBoldTextEnabled as (() => Promise<boolean>) | undefined)?.().then(setBoldText).catch(() => {});

    const motionSub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const readerSub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderActive);

    return () => {
      motionSub.remove();
      readerSub.remove();
    };
  }, []);

  return { reduceMotion, screenReaderActive, boldText };
}

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useAccessibilitySettings() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [screenReaderActive, setScreenReaderActive] = useState(false);
  const [boldText, setBoldText] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    AccessibilityInfo.isScreenReaderEnabled().then(setScreenReaderActive);
    (AccessibilityInfo.isBoldTextEnabled as (() => Promise<boolean>) | undefined)?.().then(setBoldText);

    const motionSub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const readerSub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderActive);

    return () => {
      motionSub.remove();
      readerSub.remove();
    };
  }, []);

  return { reduceMotion, screenReaderActive, boldText };
}

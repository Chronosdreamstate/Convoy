import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useReduceMotion } from './useReduceMotion';

export function useAccessibilitySettings() {
  // Reduce-motion probing/subscription is delegated to the shared
  // useReduceMotion hook (same probe + reduceMotionChanged subscription this
  // hook used to do inline) so there is a single implementation of it.
  const reduceMotion = useReduceMotion();
  const [screenReaderActive, setScreenReaderActive] = useState(false);
  const [boldText, setBoldText] = useState(false);

  useEffect(() => {
    // .catch: these can reject on platforms lacking the capability — an
    // accessibility probe failure must never surface as an unhandled rejection.
    AccessibilityInfo.isScreenReaderEnabled().then(setScreenReaderActive).catch(() => {});
    (AccessibilityInfo.isBoldTextEnabled as (() => Promise<boolean>) | undefined)?.().then(setBoldText).catch(() => {});

    const readerSub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderActive);

    return () => {
      readerSub.remove();
    };
  }, []);

  return { reduceMotion, screenReaderActive, boldText };
}

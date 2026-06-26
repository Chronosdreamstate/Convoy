import { Vibration } from 'react-native';

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

const PATTERNS: Record<HapticStyle, number | number[]> = {
  light:   30,
  medium:  50,
  heavy:   80,
  success: [0, 40, 60, 40],
  warning: [0, 60, 40, 60],
  error:   [0, 80, 40, 80, 40, 80],
};

export const HapticService = {
  trigger(style: HapticStyle = 'medium'): void {
    const pattern = PATTERNS[style];
    Vibration.vibrate(pattern);
  },
  pttStart(): void {
    Vibration.vibrate(30);
  },
  pttEnd(): void {
    Vibration.vibrate([0, 20]);
  },
  cancel(): void {
    Vibration.cancel();
  },
};

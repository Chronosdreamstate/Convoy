import { create } from 'zustand';

interface MotionStore {
  isInMotion: boolean;
  setIsInMotion: (v: boolean) => void;
}

export const useMotionStore = create<MotionStore>((set) => ({
  isInMotion: false,
  setIsInMotion: (v) => set({ isInMotion: v }),
}));

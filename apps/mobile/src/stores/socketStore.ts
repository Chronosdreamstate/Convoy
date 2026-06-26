import { create } from 'zustand';
import { Socket } from 'socket.io-client';

interface SocketState {
  socket: Socket | null;
  isConnected: boolean;
  setSocket: (socket: Socket | null) => void;
  setConnected: (connected: boolean) => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  isConnected: false,
  setSocket: (socket) => {
    const prev = get().socket;
    if (prev && prev !== socket) {
      prev.disconnect();
    }
    set({ socket, isConnected: socket?.connected ?? false });
  },
  setConnected: (isConnected) => set({ isConnected }),
}));

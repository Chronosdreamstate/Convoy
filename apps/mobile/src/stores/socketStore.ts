import { create } from 'zustand';
import { Socket } from 'socket.io-client';

interface SocketState {
  socket: Socket | null;
  isConnected: boolean;
  onlineUserIds: Set<string>;
  lastSeenMap: Map<string, string>; // userId -> ISO timestamp
  setSocket: (socket: Socket | null) => void;
  setConnected: (connected: boolean) => void;
  updatePresence: (userIds: string[]) => void;
  _handlePresenceUpdate: (data: { userId: string; isOnline: boolean; lastSeen: string }) => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  isConnected: false,
  onlineUserIds: new Set<string>(),
  lastSeenMap: new Map<string, string>(),

  setSocket: (socket) => {
    const prev = get().socket;
    if (prev && prev !== socket) {
      prev.off('member:online');
      prev.off('member:offline');
      prev.off('presence:update');
      prev.disconnect();
    }

    if (socket) {
      socket.on('member:online', ({ userId }: { userId: string }) => {
        set((state) => ({
          onlineUserIds: new Set([...state.onlineUserIds, userId]),
        }));
      });

      socket.on('member:offline', ({ userId }: { userId: string }) => {
        set((state) => {
          const next = new Set(state.onlineUserIds);
          next.delete(userId);
          return { onlineUserIds: next };
        });
      });

      socket.on('presence:update', (data: { userId: string; isOnline: boolean; lastSeen: string }) => {
        get()._handlePresenceUpdate(data);
      });
    }

    set({ socket, isConnected: socket?.connected ?? false });
  },

  setConnected: (isConnected) => set({ isConnected }),

  updatePresence: (userIds: string[]) => {
    const { socket } = get();
    if (!socket?.connected || userIds.length === 0) return;
    socket.emit(
      'presence:get',
      { userIds },
      (results: { id: string; isOnline: boolean; lastSeen: string | null }[]) => {
        if (!Array.isArray(results)) return;
        set((state) => {
          const next = new Set(state.onlineUserIds);
          const lastSeenNext = new Map(state.lastSeenMap);
          for (const r of results) {
            if (r.isOnline) next.add(r.id);
            else next.delete(r.id);
            if (r.lastSeen) lastSeenNext.set(r.id, r.lastSeen);
          }
          return { onlineUserIds: next, lastSeenMap: lastSeenNext };
        });
      },
    );
  },

  _handlePresenceUpdate: (data) => {
    set((state) => {
      const next = new Set(state.onlineUserIds);
      const lastSeenNext = new Map(state.lastSeenMap);
      if (data.isOnline) next.add(data.userId);
      else next.delete(data.userId);
      if (data.lastSeen) lastSeenNext.set(data.userId, data.lastSeen);
      return { onlineUserIds: next, lastSeenMap: lastSeenNext };
    });
  },
}));

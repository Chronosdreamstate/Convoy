import { create } from 'zustand';
import { Socket } from 'socket.io-client';

interface SocketState {
  socket: Socket | null;
  isConnected: boolean;
  onlineUserIds: Set<string>;
  lastSeenMap: Map<string, string>; // userId -> ISO timestamp
  setSocket: (socket: Socket | null) => void;
  setConnected: (connected: boolean) => void;
  /** Disconnect the socket and clear all presence state (e.g. on sign-out). */
  reset: () => void;
  updatePresence: (userIds: string[]) => void;
  _handlePresenceUpdate: (data: { userId: string; isOnline: boolean; lastSeen: string }) => void;
}

// connect/disconnect handlers attached to the CURRENT store socket, kept so
// they can be detached precisely when the socket is replaced. Screens may run
// several WebSocketService instances concurrently (e.g. IdleMapScreen's
// personal-room socket never enters the store) — tracking per-socket ensures
// only the store's active socket ever drives `isConnected`, and detaching by
// handler reference never strips listeners other code attached to the same
// events (WebSocketService's heartbeat, MapScreen's own connect handlers).
let liveHandlers: { onConnect: () => void; onDisconnect: () => void } | null = null;

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  isConnected: false,
  onlineUserIds: new Set<string>(),
  lastSeenMap: new Map<string, string>(),

  setSocket: (socket) => {
    const prev = get().socket;
    if (prev === socket) {
      // Same socket re-set — listeners are already attached; just refresh the
      // connected flag rather than stacking duplicate handlers.
      set({ isConnected: socket?.connected ?? false });
      return;
    }
    if (prev) {
      prev.off('member:online');
      prev.off('member:offline');
      prev.off('presence:update');
      if (liveHandlers) {
        prev.off('connect', liveHandlers.onConnect);
        prev.off('disconnect', liveHandlers.onDisconnect);
      }
      prev.disconnect();
    }
    liveHandlers = null;

    if (socket) {
      // Keep isConnected live for the whole app (offline banners, chat poll
      // fallback) — guard on identity so a socket that was already replaced
      // can never flip the flag for its successor.
      const onConnect = () => {
        if (get().socket === socket) set({ isConnected: true });
      };
      const onDisconnect = () => {
        if (get().socket === socket) set({ isConnected: false });
      };
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
      liveHandlers = { onConnect, onDisconnect };
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

  reset: () => {
    // setSocket(null) detaches listeners and disconnects the previous socket;
    // presence data is per-account and must not leak into the next session.
    get().setSocket(null);
    set({ onlineUserIds: new Set<string>(), lastSeenMap: new Map<string, string>() });
  },

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

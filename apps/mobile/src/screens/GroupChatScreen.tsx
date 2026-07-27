/**
 * GroupChatScreen — real-time group text chat.
 * Full-screen dark chat UI with cursor-based pagination and socket live updates.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { FileSystemUploadType } from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../stores/authStore';
import { useSocketStore } from '../stores/socketStore';
import { useGroupStore } from '../stores/groupStore';
import { apiClient } from '../services/apiClient';
import { SkeletonRow } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { theme, useTheme, ThemeColors, withAlpha } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Reaction {
  emoji: string;
  userIds: string[];
}

interface Message {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  text: string | null;
  audioUrl?: string | null;
  createdAt: string;
  type?: 'message' | 'system' | 'text' | 'voice';
  reactions?: Reaction[];
  // Optimistic-send bookkeeping — never sent to/from the server. `pending`
  // marks a locally-added bubble still waiting on the POST round-trip;
  // `failed` marks one whose send errored, so it can render a tap-to-retry
  // affordance in place instead of silently vanishing back into the input.
  pending?: boolean;
  failed?: boolean;
}

const QUICK_REPLIES = [
  { label: '👍 Got it', text: '👍 Got it' },
  { label: '⚠️ Slow down', text: '⚠️ Slow down' },
  { label: '🅿️ Need to stop', text: '🅿️ Need to stop' },
  { label: '✅ On my way', text: '✅ On my way' },
];

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '⚠️'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function avatarInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Pure reducer applying an add/remove reaction to a message list. Shared by
 * the socket `group:reaction` handler and the optimistic local apply in
 * `handleReact` so both paths stay in sync. Idempotent: adds use a Set, and
 * removing an absent reaction is a no-op — safe when the socket echo of our
 * own REST call arrives after we've already applied it locally.
 */
function applyReactionToMessages(
  messages: Message[],
  payload: { messageId: string; emoji: string; userId: string; action: 'add' | 'remove' },
): Message[] {
  return messages.map((m) => {
    if (m.id !== payload.messageId) return m;
    const reactions = m.reactions ? [...m.reactions] : [];
    const idx = reactions.findIndex((r) => r.emoji === payload.emoji);
    if (payload.action === 'add') {
      if (idx >= 0) {
        reactions[idx] = { ...reactions[idx], userIds: [...new Set([...reactions[idx].userIds, payload.userId])] };
      } else {
        reactions.push({ emoji: payload.emoji, userIds: [payload.userId] });
      }
    } else {
      if (idx >= 0) {
        const userIds = reactions[idx].userIds.filter((id) => id !== payload.userId);
        if (userIds.length === 0) reactions.splice(idx, 1);
        else reactions[idx] = { ...reactions[idx], userIds };
      }
    }
    return { ...m, reactions };
  });
}

// ---------------------------------------------------------------------------
// ReactionPicker
// ---------------------------------------------------------------------------

interface ReactionPickerProps {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onDismiss: () => void;
}

function ReactionPicker({ visible, onSelect, onDismiss }: ReactionPickerProps) {
  const { colors } = useTheme();
  const pickerStyles = useMemo(() => createPickerStyles(colors), [colors]);
  const reduceMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // With OS reduce-motion on, the picker appears in place instead of
    // springing in — same affordance, no scale animation.
    if (reduceMotion) {
      scale.setValue(visible ? 1 : 0);
      return;
    }
    Animated.spring(scale, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      tension: 120,
      friction: 8,
    }).start();
  }, [visible, scale, reduceMotion]);

  if (!visible) return null;

  return (
    <Modal transparent animationType="none" onRequestClose={onDismiss}>
      <TouchableWithoutFeedback onPress={onDismiss}>
        <View style={pickerStyles.overlay}>
          <TouchableWithoutFeedback>
            <Animated.View style={[pickerStyles.container, { transform: [{ scale }] }]}>
              {REACTION_EMOJIS.map((emoji) => (
                <TouchableOpacity
                  key={emoji}
                  style={pickerStyles.emojiBtn}
                  onPress={() => { onSelect(emoji); onDismiss(); }}
                  accessibilityRole="button"
                  accessibilityLabel={`React with ${emoji}`}
                >
                  <Text style={pickerStyles.emoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function createPickerStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.4)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    container: {
      flexDirection: 'row',
      backgroundColor: colors.cardElevated,
      borderRadius: 32,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 4,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
      elevation: 8,
    },
    emojiBtn: {
      padding: 8,
    },
    emoji: {
      fontSize: 26,
    },
  });
}

// ---------------------------------------------------------------------------
// SystemMessage
// ---------------------------------------------------------------------------

function SystemMessage({ text }: { text: string }) {
  const { colors } = useTheme();
  const sysStyles = useMemo(() => createSysStyles(colors), [colors]);
  return (
    <View style={sysStyles.row}>
      <View style={sysStyles.line} />
      <Text style={sysStyles.text}>{text}</Text>
    </View>
  );
}

function createSysStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: 6,
      paddingHorizontal: 16,
      gap: 8,
    },
    line: {
      width: 3,
      height: 14,
      backgroundColor: colors.accent,
      borderRadius: 2,
    },
    text: {
      color: colors.textMuted,
      fontSize: 12,
      fontStyle: 'italic',
      textAlign: 'center',
    },
  });
}

// ---------------------------------------------------------------------------
// VoiceMessageBubble
// ---------------------------------------------------------------------------

function VoiceMessageBubble({ audioUrl, isOwn }: { audioUrl: string; isOwn: boolean }) {
  const { colors } = useTheme();
  const [playing, setPlaying] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  const togglePlay = async () => {
    if (playing) {
      await soundRef.current?.pauseAsync();
      setPlaying(false);
    } else {
      if (!soundRef.current) {
        const { sound } = await Audio.Sound.createAsync({ uri: audioUrl });
        soundRef.current = sound;
        sound.setOnPlaybackStatusUpdate((status: { isLoaded: boolean; didJustFinish?: boolean }) => {
          if (status.isLoaded && status.didJustFinish) {
            setPlaying(false);
            soundRef.current = null;
          }
        });
      }
      await soundRef.current?.playAsync();
      setPlaying(true);
    }
  };

  useEffect(() => () => { void soundRef.current?.unloadAsync(); }, []);

  // `isOwn` bubbles sit on the accent-colored background (same in both
  // themes), so white content is always safe there. `!isOwn` bubbles sit on
  // `colors.card`, which is near-white in light mode — a fixed white overlay
  // + white text would be almost invisible, so those use theme-aware colors.
  const iconColor = isOwn ? '#FFFFFF' : colors.text;
  const labelColor = isOwn ? '#FFFFFF' : colors.textMuted;
  const bubbleStyle = isOwn
    ? { backgroundColor: 'rgba(255,255,255,0.15)' }
    : { backgroundColor: withAlpha(colors.textMuted, 0.12) };

  return (
    <TouchableOpacity
      onPress={() => void togglePlay()}
      accessibilityRole="button"
      accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
      style={[voiceStyles.bubble, bubbleStyle]}
    >
      <Ionicons name={playing ? 'pause' : 'play'} size={16} color={iconColor} />
      <Text style={[voiceStyles.label, { color: labelColor }]}>Voice message</Text>
    </TouchableOpacity>
  );
}

const voiceStyles = StyleSheet.create({
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 140,
  },
  icon: {
    fontSize: 18,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
});

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

interface BubbleProps {
  item: Message;
  isOwn: boolean;
  currentUserId: string;
  onLongPress: (messageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onRetry: (item: Message) => void;
}

function MessageBubble({ item, isOwn, currentUserId, onLongPress, onReact, onRetry }: BubbleProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (item.type === 'system') {
    return <SystemMessage text={item.text ?? ''} />;
  }

  const hasReactions = item.reactions && item.reactions.length > 0;

  return (
    <View style={[styles.messageRow, isOwn ? styles.messageRowRight : styles.messageRowLeft]}>
      {!isOwn && (
        <View style={styles.avatar}>
          {item.avatarUrl ? (
            <Image
              source={{ uri: item.avatarUrl }}
              style={styles.avatarImage}
              accessibilityLabel={`${item.displayName}'s avatar`}
            />
          ) : (
            <Text style={styles.avatarInitials}>{avatarInitials(item.displayName)}</Text>
          )}
        </View>
      )}
      <View style={isOwn ? styles.bubbleWrapRight : styles.bubbleWrapLeft}>
        <TouchableOpacity
          onPress={item.failed ? () => onRetry(item) : undefined}
          onLongPress={() => onLongPress(item.id)}
          activeOpacity={0.85}
          delayLongPress={350}
          accessibilityRole={item.failed ? 'button' : undefined}
          accessibilityLabel={item.failed ? 'Message failed to send. Tap to retry.' : undefined}
        >
          <View style={[
            styles.bubble,
            isOwn ? styles.bubbleOwn : styles.bubbleOther,
            item.pending && styles.bubblePending,
            item.failed && styles.bubbleFailed,
          ]}>
            {!isOwn && (
              <Text style={styles.senderName}>{item.displayName}</Text>
            )}
            {item.type === 'voice' ? (
              <VoiceMessageBubble audioUrl={item.audioUrl ?? ''} isOwn={isOwn} />
            ) : (
              <Text style={[styles.bubbleText, isOwn ? styles.bubbleTextOwn : styles.bubbleTextOther]}>
                {item.text}
              </Text>
            )}
          </View>
        </TouchableOpacity>
        {item.failed && (
          <View style={[styles.failedRow, isOwn && styles.failedRowRight]}>
            <Ionicons name="alert-circle" size={12} color={colors.error} />
            <Text style={styles.failedText}>Failed to send · Tap to retry</Text>
          </View>
        )}
        {hasReactions && (
          <View style={[styles.reactionsRow, isOwn && styles.reactionsRowRight]}>
            {item.reactions!.map((r) => (
              <TouchableOpacity
                key={r.emoji}
                style={[
                  styles.reactionPill,
                  r.userIds.includes(currentUserId) && styles.reactionPillOwn,
                ]}
                onPress={() => onReact(item.id, r.emoji)}
                accessibilityRole="button"
                accessibilityLabel={`${r.emoji} ${r.userIds.length}`}
              >
                <Text style={styles.reactionEmoji}>{r.emoji}</Text>
                <Text style={styles.reactionCount}>{r.userIds.length}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// GroupChatScreen
// ---------------------------------------------------------------------------

export default function GroupChatScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const router = useRouter();
  const { accessToken, user } = useAuthStore();
  const { socket } = useSocketStore();
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [reactionTarget, setReactionTarget] = useState<string | null>(null);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  // This screen is reused verbatim for one-off DMs — both the Friends
  // screen's "Message" action and the Nearby screen's "Chat" button navigate
  // here with a groupId that points at a convoy_groups row of type 'dm'
  // (see migration 014_direct_messages.sql). `otherParticipant` is only
  // populated for DM-type groups, driving both the header identity display
  // and the in-chat block affordance below.
  const [groupType, setGroupType] = useState<'group' | 'dm'>('group');
  const [otherParticipant, setOtherParticipant] = useState<{
    userId: string;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);
  const [blocking, setBlocking] = useState(false);

  const flatListRef = useRef<FlatList<Message>>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentUserId = user?.id ?? '';

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const loadInitialMessages = useCallback(async () => {
    if (!groupId || !accessToken) return;
    setLoading(true);
    setLoadError(false);
    try {
      const { data } = await apiClient.get<{ messages: Message[]; nextCursor: string | null }>(
        `/api/v1/groups/${groupId}/messages?limit=50`,
      );
      setMessages(data.messages);
      setNextCursor(data.nextCursor);
    } catch {
      // Distinguishable from a genuinely empty conversation — a failed
      // fetch (or a 403 from ongoing-DM block enforcement) must not render
      // as the same "No messages yet. Say hi!" empty state a brand-new
      // thread shows, especially for a DM with real history.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [groupId, accessToken]);

  useEffect(() => {
    void loadInitialMessages();
  }, [loadInitialMessages]);

  // Determine whether this is a real convoy group or a one-off DM thread,
  // and — for DMs — who the other participant is, so the header can show
  // their identity instead of the generic "GROUP CHAT" label (and so the
  // block affordance below knows who to block).
  const loadGroupInfo = useCallback(async () => {
    if (!groupId || !accessToken) return;
    try {
      const { data } = await apiClient.get<{ type?: 'group' | 'dm' }>(`/api/v1/groups/${groupId}`);
      const type = data.type ?? 'group';
      setGroupType(type);
      if (type === 'dm') {
        const membersRes = await apiClient.get<{
          members: Array<{ userId: string; displayName: string; avatarUrl: string | null }>;
        }>(`/api/v1/groups/${groupId}/members`);
        const other = membersRes.data.members.find((m) => m.userId !== currentUserId) ?? null;
        setOtherParticipant(other);
      }
    } catch {
      // silently fail — header falls back to the generic "GROUP CHAT" label
    }
  }, [groupId, accessToken, currentUserId]);

  useEffect(() => {
    void loadGroupInfo();
  }, [loadGroupInfo]);

  const loadMoreMessages = useCallback(async () => {
    if (!groupId || !accessToken || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { data } = await apiClient.get<{ messages: Message[]; nextCursor: string | null }>(
        `/api/v1/groups/${groupId}/messages?before=${encodeURIComponent(nextCursor)}&limit=50`,
      );
      setMessages((prev) => [...prev, ...data.messages]);
      setNextCursor(data.nextCursor);
    } catch {
      // silently fail
    } finally {
      setLoadingMore(false);
    }
  }, [groupId, accessToken, nextCursor, loadingMore]);

  // ---------------------------------------------------------------------------
  // Socket: real-time updates
  // ---------------------------------------------------------------------------

  // Which threads does the socket cover live?
  //  * The active convoy's room — joined at connect.
  //  * Every DM room the user belongs to — the server joins them at connect
  //    and on POST /dm, and the dm:join emit below covers channels created
  //    mid-session. So a connected socket pushes `group:message` /
  //    `group:reaction` for DM threads too — no polling needed.
  // A chat opened for some *other* (non-active, non-DM) group is NOT covered:
  // its events must be filtered out (or convoy chatter would bleed into this
  // view) and the poll fallback below keeps that thread alive instead.
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const socketCoversThread =
    !!socket && !!groupId && (groupId === activeGroupId || groupType === 'dm');

  // Live connectivity — server push only reaches us while the socket is
  // actually connected; when it drops, the poll below takes over as the
  // degraded-mode fallback until socket.io reconnects. The store's
  // `isConnected` flag tracks exactly this socket (the screen reads `socket`
  // from the same store, and socketStore.setSocket attaches identity-guarded
  // connect/disconnect handlers), so no local listeners are needed here.
  const socketConnected = useSocketStore((s) => s.isConnected);

  // DM threads: make sure this socket is in the thread's room. Connect-time
  // join on the server only sees channels that existed at connect, so a
  // channel created mid-session (e.g. the other side just opened this DM)
  // would otherwise miss live events until reconnect. Idempotent; the server
  // verifies membership before joining.
  useEffect(() => {
    if (!socket || !groupId || groupType !== 'dm') return;
    const join = () => socket.emit('dm:join', { groupId });
    if (socket.connected) join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
    };
  }, [socket, groupId, groupType]);

  useEffect(() => {
    if (!socket) return;

    const handleMessage = (msg: Message & { groupId?: string }) => {
      // Only accept messages for THIS thread — the socket room is scoped to
      // the active convoy, which may not be the thread on screen (see above).
      // Legacy events without a groupId can only be attributed here when the
      // thread on screen IS the active convoy: this socket is in the convoy
      // room *and* every DM room at once, so while a DM is open an unstamped
      // convoy broadcast would otherwise bleed into the DM transcript.
      if (msg.groupId ? msg.groupId !== groupId : groupId !== activeGroupId) return;
      // De-duped by id: the sender's own message is already added optimistically
      // by `sendMessage` (and reconciled with the real id from the POST
      // response) before this broadcast round-trips back, so without this
      // check the sender would see their own message twice.
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [msg, ...prev]));
    };

    const handleReaction = (payload: { messageId: string; emoji: string; userId: string; action: 'add' | 'remove' }) => {
      // Reactions for other threads match no messageId here, so this is
      // inherently scoped; the reducer is also idempotent against the echo
      // of our own optimistic apply.
      setMessages((prev) => applyReactionToMessages(prev, payload));
    };

    const handleTyping = (payload: { userId: string; displayName: string; groupId?: string }) => {
      if (payload.userId === currentUserId) return;
      // The server stamps the thread's groupId on typing relays — accept only
      // events for THIS thread. Legacy events without a groupId can only be
      // attributed here when the thread on screen IS the active convoy (see
      // handleMessage above — `socketCoversThread` is also true for DMs, so
      // it cannot distinguish which covered room an unstamped event came from).
      if (payload.groupId ? payload.groupId !== groupId : groupId !== activeGroupId) return;
      setTypingUser(payload.displayName);
      if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
      typingClearTimerRef.current = setTimeout(() => setTypingUser(null), 3000);
    };

    socket.on('group:message', handleMessage);
    socket.on('group:reaction', handleReaction);
    socket.on('chat:typing', handleTyping);

    return () => {
      socket.off('group:message', handleMessage);
      socket.off('group:reaction', handleReaction);
      socket.off('chat:typing', handleTyping);
    };
  }, [socket, currentUserId, groupId, activeGroupId]);

  // Degraded-mode fallback ONLY: DM threads (and the active convoy's chat)
  // are pushed live over the socket, so polling runs solely while the socket
  // can't cover this thread — either it's disconnected, or the thread is a
  // non-active non-DM group the socket has no room for. Once the socket
  // (re)connects and covers the thread, the poll stops.
  useEffect(() => {
    if ((socketCoversThread && socketConnected) || !groupId || !accessToken || loading || loadError) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const { data } = await apiClient.get<{ messages: Message[] }>(
            `/api/v1/groups/${groupId}/messages?limit=20`,
          );
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const fresh = data.messages.filter((m) => !seen.has(m.id));
            return fresh.length > 0 ? [...fresh, ...prev] : prev;
          });
        } catch { /* transient poll failure — next tick retries */ }
      })();
    }, 6000);
    return () => clearInterval(timer);
  }, [socketCoversThread, socketConnected, groupId, accessToken, loading, loadError]);

  // Cleanup timers and recording on unmount
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      void recordingRef.current?.stopAndUnloadAsync().catch(() => {});
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  // `fromComposer` — true only when sending the text currently in the input
  // box. Quick replies and failed-bubble retries send their own text, so they
  // must NOT clear the input: a half-typed draft would silently vanish.
  const sendMessage = useCallback(async (text: string, opts?: { fromComposer?: boolean }) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 500 || sending || !groupId || !accessToken) return;
    setSending(true);
    if (opts?.fromComposer) setInputText('');

    // Optimistic bubble — appears instantly instead of waiting on the POST
    // round-trip (and the socket echo after that). Reconciled with the real
    // server row on success, or flipped to a tap-to-retry state on failure.
    const clientId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage: Message = {
      id: clientId,
      userId: currentUserId,
      displayName: user?.displayName ?? 'You',
      avatarUrl: user?.avatarUrl ?? null,
      text: trimmed,
      createdAt: new Date().toISOString(),
      type: 'text',
      pending: true,
    };
    setMessages((prev) => [optimisticMessage, ...prev]);
    // The list is `inverted`, so a new message lands at the visual bottom only
    // if the scroll offset is already there — if the user had scrolled up into
    // history, force it back so they actually see the message they just sent.
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });

    try {
      const { data } = await apiClient.post<Message>(`/api/v1/groups/${groupId}/messages`, { text: trimmed });
      setMessages((prev) => prev.map((m) => (m.id === clientId ? { ...data, pending: false } : m)));
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === clientId ? { ...m, pending: false, failed: true } : m)));
    } finally {
      setSending(false);
    }
  }, [sending, groupId, accessToken, currentUserId, user]);

  const handleSend = useCallback(() => sendMessage(inputText, { fromComposer: true }), [inputText, sendMessage]);

  const handleQuickReply = useCallback((text: string) => sendMessage(text), [sendMessage]);

  // Tapping a failed bubble drops it and re-sends the same text as a fresh
  // optimistic message, rather than dumping it back into the input box.
  const handleRetry = useCallback((message: Message) => {
    if (!message.text) return;
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
    void sendMessage(message.text);
  }, [sendMessage]);

  // ---------------------------------------------------------------------------
  // Voice recording
  // ---------------------------------------------------------------------------

  const startRecording = useCallback(async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      Alert.alert('Permission Required', 'Microphone access is required to send voice messages.');
      return;
    }
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingDuration(0);
      durationIntervalRef.current = setInterval(() => setRecordingDuration((d) => d + 1), 1000);
    } catch {
      // e.g. mic held by another app, or audio session init failure — without
      // this catch the promise rejection was unhandled and the button did
      // nothing with no feedback.
      Alert.alert('Recording Unavailable', 'Could not start recording. Close other apps using the microphone and try again.');
    }
  }, []);

  // Upload + send an already-recorded voice file. Separated from the
  // stop-recording step so a failed upload can be retried without losing
  // the recording the user just made.
  const uploadVoiceMessage = useCallback(async (uri: string) => {
    if (!groupId || !accessToken) return;
    setSending(true);
    try {
      const uploadResult = await FileSystem.uploadAsync(
        `${apiUrl}/api/v1/uploads/audio`,
        uri,
        {
          httpMethod: 'POST',
          uploadType: FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: 'audio/m4a',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      const { url: audioUrl } = JSON.parse(uploadResult.body) as { url: string };
      const { data } = await apiClient.post<Message>(`/api/v1/groups/${groupId}/messages`, { type: 'voice', audioUrl });
      // Show the sent voice message immediately — outside an active convoy
      // there is no socket echo to deliver it back to the sender.
      setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [data, ...prev]));
    } catch {
      // Keep the recording and offer a retry rather than silently discarding
      // what the user just said.
      Alert.alert('Failed to Send', 'Could not send voice message.', [
        { text: 'Discard', style: 'destructive' },
        { text: 'Retry', onPress: () => void uploadVoiceMessage(uri) },
      ]);
    } finally {
      setSending(false);
    }
  }, [groupId, accessToken, apiUrl]);

  const stopAndSendRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    setIsRecording(false);
    setRecordingDuration(0);
    const recording = recordingRef.current;
    recordingRef.current = null;
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    } catch {
      Alert.alert('Failed', 'Could not finish the recording. Please try again.');
      return;
    }
    const uri = recording.getURI();
    if (!uri) return;
    await uploadVoiceMessage(uri);
  }, [uploadVoiceMessage]);

  const handleVoicePress = useCallback(() => {
    if (isRecording) {
      void stopAndSendRecording();
    } else {
      void startRecording();
    }
  }, [isRecording, startRecording, stopAndSendRecording]);

  // ---------------------------------------------------------------------------
  // Typing indicator
  // ---------------------------------------------------------------------------

  const handleInputChange = useCallback((text: string) => {
    setInputText(text);
    // Only emit typing for threads the socket covers (active convoy or a DM
    // room it has joined). The server relays `chat:typing` to the payload's
    // groupId room after verifying this socket is actually in it, so DM
    // typing indicators work and nothing can leak into the wrong thread.
    if (!socket || !socketCoversThread || !groupId || !user) return;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit('chat:typing', { groupId, displayName: user.displayName ?? 'Someone' });
    }, 1000);
  }, [socket, socketCoversThread, groupId, user]);

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  const handleLongPress = useCallback((messageId: string) => {
    setReactionTarget(messageId);
  }, []);

  // Reactions go through the REST endpoint (which persists AND broadcasts the
  // socket event server-side) rather than a raw `chat:react` socket emit. The
  // socket emit was scoped to the socket's own convoy room, so it silently
  // did nothing in DMs and whenever no convoy socket existed. The optimistic
  // local apply keeps the pill instant; a failed call rolls it back.
  const handleReact = useCallback((messageId: string, emoji: string) => {
    if (!groupId || !currentUserId) return;
    const msg = messages.find((m) => m.id === messageId);
    if (msg?.pending || msg?.failed || msg?.id.startsWith('local-')) return; // not on the server yet
    const reaction = msg?.reactions?.find((r) => r.emoji === emoji);
    const alreadyReacted = reaction?.userIds.includes(currentUserId) ?? false;
    const action: 'add' | 'remove' = alreadyReacted ? 'remove' : 'add';

    setMessages((prev) => applyReactionToMessages(prev, { messageId, emoji, userId: currentUserId, action }));

    const request = action === 'add'
      ? apiClient.post(`/api/v1/groups/${groupId}/messages/${messageId}/react`, { emoji })
      : apiClient.delete(`/api/v1/groups/${groupId}/messages/${messageId}/react`, { data: { emoji } });
    request.catch(() => {
      // Roll back the optimistic apply
      setMessages((prev) => applyReactionToMessages(prev, {
        messageId,
        emoji,
        userId: currentUserId,
        action: action === 'add' ? 'remove' : 'add',
      }));
    });
  }, [groupId, messages, currentUserId]);

  const handleReactionSelect = useCallback((emoji: string) => {
    if (reactionTarget) handleReact(reactionTarget, emoji);
  }, [reactionTarget, handleReact]);

  // ---------------------------------------------------------------------------
  // Block (DM safety affordance) — mirrors the confirm-then-block convention
  // used by UserProfileScreen.handleBlock / FriendsScreen.handleBlock: a
  // destructive confirmation dialog, then the shared block endpoint, then a
  // success dialog. Continuing to message someone right after blocking them
  // doesn't make sense, so on success we navigate back out of the chat —
  // same as UserProfileScreen does after a successful block.
  // ---------------------------------------------------------------------------

  const handleBlockPress = useCallback(() => {
    if (!otherParticipant || blocking) return;
    const name = otherParticipant.displayName;
    Alert.alert(
      'Block User',
      `Block ${name}? They won't be able to send you friend requests or see your location, any existing friendship will be removed, and you won't be able to continue this conversation.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBlocking(true);
              try {
                await apiClient.post('/api/v1/friends/block', { userId: otherParticipant.userId });
                Alert.alert('User Blocked', `${name} has been blocked.`, [
                  { text: 'OK', onPress: () => router.back() },
                ]);
              } catch {
                Alert.alert('Error', 'Could not block this user. Please try again.');
              } finally {
                setBlocking(false);
              }
            })();
          },
        },
      ],
    );
  }, [otherParticipant, blocking, router]);

  const handleHeaderMenu = useCallback(() => {
    if (!otherParticipant) return;
    Alert.alert(
      otherParticipant.displayName,
      undefined,
      [
        { text: '⛔ Block User', style: 'destructive', onPress: handleBlockPress },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [otherParticipant, handleBlockPress]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble
        item={item}
        isOwn={item.userId === currentUserId}
        currentUserId={currentUserId}
        onLongPress={handleLongPress}
        onReact={handleReact}
        onRetry={handleRetry}
      />
    ),
    [currentUserId, handleLongPress, handleReact, handleRetry],
  );

  const keyExtractor = useCallback((item: Message) => item.id, []);
  const canSend = inputText.trim().length > 0 && inputText.length <= 500 && !sending;

  // Req 33 — while in motion the transcript shows at most the LATEST 4
  // messages. `messages` is newest-first (arrivals are prepended for the
  // `inverted` list), so the shared hook's slice(0, CAP) keeps exactly the
  // most recent rows — the same recency rule PTTLogPanel gets from
  // `slice(-CAP)` over its oldest-first entries.
  const {
    data: visibleMessages,
    isCapped: isMotionCapped,
    hiddenCount: hiddenMessageCount,
  } = useMotionCappedData(messages);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme.hitSlop}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.textMuted} style={styles.backBtn} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          {groupType === 'dm' && otherParticipant ? (
            <>
              <View style={styles.headerAvatar}>
                {otherParticipant.avatarUrl ? (
                  <Image
                    source={{ uri: otherParticipant.avatarUrl }}
                    style={styles.headerAvatarImage}
                    accessibilityLabel={`${otherParticipant.displayName}'s avatar`}
                  />
                ) : (
                  <Text style={styles.headerAvatarInitials}>
                    {avatarInitials(otherParticipant.displayName)}
                  </Text>
                )}
              </View>
              <Text style={styles.headerTitleDm} numberOfLines={1}>
                {otherParticipant.displayName}
              </Text>
            </>
          ) : (
            <Text style={styles.headerTitle}>GROUP CHAT</Text>
          )}
        </View>
        {groupType === 'dm' ? (
          <TouchableOpacity
            style={styles.headerKebab}
            onPress={handleHeaderMenu}
            hitSlop={theme.hitSlop}
            accessibilityRole="button"
            accessibilityLabel="Chat options"
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerRight} />
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.flex}>
            {loading ? (
              <View style={styles.skeletonContainer}>
                {Array.from({ length: 7 }).map((_, i) => (
                  <View key={i} style={styles.skeletonRow}>
                    <SkeletonRow />
                  </View>
                ))}
              </View>
            ) : loadError ? (
              <NetworkError
                onRetry={() => void loadInitialMessages()}
                message="Could not load messages. Please check your connection."
              />
            ) : (
              <FlatList
                ref={flatListRef}
                data={visibleMessages}
                keyExtractor={keyExtractor}
                renderItem={renderMessage}
                inverted
                contentContainerStyle={styles.listContent}
                // While capped there's no point paginating older history the
                // driver can't see anyway — and a 4-row list hits its end
                // immediately, which would otherwise fetch page after page
                // into the hidden tail.
                onEndReached={isMotionCapped ? undefined : loadMoreMessages}
                onEndReachedThreshold={0.4}
                ListHeaderComponent={
                  // The list is `inverted`, so the header renders at the
                  // visual BOTTOM — pinned next to the newest message, the one
                  // spot guaranteed on-screen in a chat (a footer would sit at
                  // the visual top, off-screen whenever the 4 remaining
                  // bubbles overflow the viewport). Counter-flipped like the
                  // footer/empty components below.
                  <View style={styles.invertedFix}>
                    <MotionCapNotice hiddenCount={hiddenMessageCount} />
                  </View>
                }
                ListFooterComponent={
                  loadingMore ? (
                    // `inverted` scaleY(-1)-transforms the whole content wrapper,
                    // so counter-flip this component or it renders upside down.
                    <View style={[styles.loadingMoreContainer, styles.invertedFix]}><SkeletonRow /></View>
                  ) : null
                }
                ListEmptyComponent={
                  <View style={[styles.emptyContainer, styles.invertedFix]}>
                    <Ionicons name="chatbubble-outline" size={40} color={colors.textSubtle} />
                    <Text style={styles.emptyText}>No messages yet. Say hi!</Text>
                  </View>
                }
                keyboardShouldPersistTaps="handled"
              />
            )}

            {/* Typing indicator */}
            {typingUser !== null && (
              <View style={styles.typingBar}>
                <Text style={styles.typingText}>{typingUser} is typing…</Text>
              </View>
            )}
          </View>
        </TouchableWithoutFeedback>

        {/* Quick replies */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.quickRepliesContainer}
          contentContainerStyle={styles.quickRepliesContent}
          keyboardShouldPersistTaps="always"
        >
          {QUICK_REPLIES.map((qr) => (
            <TouchableOpacity
              key={qr.label}
              // Disabled while a send is in flight — sendMessage no-ops when
              // `sending`, so an enabled-looking chip would silently swallow
              // the tap. Dimming + disabling matches how the composer's Send
              // button reports the same in-flight state.
              style={[styles.quickReplyPill, sending && styles.quickReplyPillDisabled]}
              onPress={() => handleQuickReply(qr.text)}
              disabled={sending}
              accessibilityRole="button"
              accessibilityLabel={qr.label}
              accessibilityState={{ disabled: sending }}
            >
              <Text style={styles.quickReplyText}>{qr.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Input bar */}
        <View style={styles.inputBar}>
          <View style={styles.inputWrapper}>
            <TextInput
              style={styles.textInput}
              value={inputText}
              onChangeText={handleInputChange}
              placeholder="Type a message..."
              placeholderTextColor={colors.textSubtle}
              multiline
              maxLength={500}
              returnKeyType="default"
              accessibilityLabel="Message input"
            />
            {inputText.length > 400 && (
              <Text style={[styles.charCounter, inputText.length > 500 && styles.charCounterOver]}>
                {inputText.length}/500
              </Text>
            )}
          </View>

          {/* Voice recording button */}
          <TouchableOpacity
            style={[styles.voiceBtn, isRecording && styles.voiceBtnActive]}
            onPress={handleVoicePress}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel={isRecording ? 'Stop recording and send voice message' : 'Record voice message'}
          >
            <Ionicons
              name={isRecording ? 'stop-circle' : 'mic-outline'}
              size={18}
              color={isRecording ? colors.accent : colors.textMuted}
            />
            {isRecording && recordingDuration > 0 && (
              <Text style={styles.recordingTimer}>{recordingDuration}s</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend }}
          >
            <Text style={[styles.sendBtnText, !canSend && styles.sendBtnTextDisabled]}>
              Send
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Reaction picker modal */}
      <ReactionPicker
        visible={reactionTarget !== null}
        onSelect={handleReactionSelect}
        onDismiss={() => setReactionTarget(null)}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const BUBBLE_RADIUS = 16;

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 2,
  },
  backBtn: {
    color: colors.textMuted,
    fontSize: 22,
    fontWeight: '600',
    width: 32,
  },
  headerRight: {
    width: 32,
  },
  headerTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
  },
  headerTitleDm: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
    flexShrink: 1,
  },
  headerAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerAvatarImage: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  headerAvatarInitials: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  headerKebab: {
    width: 32,
    alignItems: 'flex-end',
    paddingVertical: 4,
    justifyContent: 'center',
  },

  // Skeleton loading
  skeletonContainer: {
    flex: 1,
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  skeletonRow: {
    marginBottom: theme.spacing.sm,
  },

  // Message list
  listContent: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    flexGrow: 1,
  },
  loadingMoreContainer: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  // Counter-flips ListEmptyComponent/ListFooterComponent against the
  // FlatList's `inverted` transform, which otherwise renders them upside down.
  invertedFix: {
    transform: [{ scaleY: -1 }],
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
    gap: 12,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyText: {
    color: colors.textSubtle,
    fontSize: 14,
  },

  // Message rows
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 4,
    gap: theme.spacing.sm,
  },
  messageRowLeft: {
    justifyContent: 'flex-start',
  },
  messageRowRight: {
    justifyContent: 'flex-end',
  },
  bubbleWrapLeft: {
    alignItems: 'flex-start',
    maxWidth: '78%',
  },
  bubbleWrapRight: {
    alignItems: 'flex-end',
    maxWidth: '78%',
  },

  // Avatar
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatarImage: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  avatarInitials: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },

  // Bubbles
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: BUBBLE_RADIUS,
  },
  bubbleOwn: {
    backgroundColor: colors.accent,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bubblePending: {
    opacity: 0.55,
  },
  bubbleFailed: {
    opacity: 0.85,
    borderWidth: 1,
    borderColor: colors.error,
  },
  senderName: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleTextOwn: {
    color: '#FFFFFF',
  },
  bubbleTextOther: {
    color: colors.text,
  },

  // Reactions
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
    marginLeft: 4,
  },
  reactionsRowRight: {
    justifyContent: 'flex-end',
    marginLeft: 0,
    marginRight: 4,
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reactionPillOwn: {
    borderColor: colors.accent,
    backgroundColor: withAlpha(colors.accent, 0.12),
  },
  reactionEmoji: {
    fontSize: 13,
  },
  reactionCount: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },

  // Failed-send affordance
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
    marginLeft: 4,
  },
  failedRowRight: {
    marginLeft: 0,
    marginRight: 4,
    justifyContent: 'flex-end',
  },
  failedText: {
    color: colors.error,
    fontSize: 11,
    fontWeight: '600',
  },

  // Typing indicator
  typingBar: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 4,
  },
  typingText: {
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
  },

  // Quick replies
  quickRepliesContainer: {
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  quickRepliesContent: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
    gap: 8,
  },
  quickReplyPill: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  quickReplyPillDisabled: {
    opacity: 0.4,
  },
  quickReplyText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },

  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  inputWrapper: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: theme.spacing.sm + 4,
    paddingTop: theme.spacing.sm + 2,
    paddingBottom: theme.spacing.sm + 2,
    minHeight: 44,
    justifyContent: 'center',
  },
  textInput: {
    color: colors.text,
    fontSize: 15,
    maxHeight: 120,
    padding: 0,
  },
  charCounter: {
    color: colors.textSubtle,
    fontSize: 10,
    textAlign: 'right',
    marginTop: 4,
  },
  charCounterOver: {
    color: colors.error,
  },

  // Voice button
  voiceBtn: {
    minWidth: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    flexDirection: 'row',
    paddingHorizontal: 8,
    gap: 4,
  },
  voiceBtnActive: {
    backgroundColor: withAlpha(colors.accent, 0.15),
    borderColor: colors.accent,
  },
  voiceBtnIcon: {
    fontSize: 18,
  },
  recordingTimer: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },

  // Send button
  sendBtn: {
    backgroundColor: colors.accent,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendBtnDisabled: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  sendBtnTextDisabled: {
    color: colors.textSubtle,
  },
  });
}

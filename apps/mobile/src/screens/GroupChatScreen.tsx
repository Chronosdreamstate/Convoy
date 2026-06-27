/**
 * GroupChatScreen — real-time group text chat.
 * Full-screen dark chat UI with cursor-based pagination and socket live updates.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import * as FileSystem from 'expo-file-system';
import { FileSystemUploadType } from 'expo-file-system';
import { useAuthStore } from '../stores/authStore';
import { useSocketStore } from '../stores/socketStore';
import { apiClient } from '../services/apiClient';
import { SkeletonRow } from '../components/SkeletonLoader';
import { theme } from '../theme';

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

// ---------------------------------------------------------------------------
// ReactionPicker
// ---------------------------------------------------------------------------

interface ReactionPickerProps {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onDismiss: () => void;
}

function ReactionPicker({ visible, onSelect, onDismiss }: ReactionPickerProps) {
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      tension: 120,
      friction: 8,
    }).start();
  }, [visible, scale]);

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

const pickerStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flexDirection: 'row',
    backgroundColor: theme.colors.cardElevated,
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

// ---------------------------------------------------------------------------
// SystemMessage
// ---------------------------------------------------------------------------

function SystemMessage({ text }: { text: string }) {
  return (
    <View style={sysStyles.row}>
      <View style={sysStyles.line} />
      <Text style={sysStyles.text}>{text}</Text>
    </View>
  );
}

const sysStyles = StyleSheet.create({
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
    backgroundColor: theme.colors.accent,
    borderRadius: 2,
  },
  text: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
  },
});

// ---------------------------------------------------------------------------
// VoiceMessageBubble
// ---------------------------------------------------------------------------

function VoiceMessageBubble({ audioUrl, isOwn }: { audioUrl: string; isOwn: boolean }) {
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

  return (
    <TouchableOpacity
      onPress={() => void togglePlay()}
      accessibilityRole="button"
      accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
      style={[voiceStyles.bubble, isOwn ? voiceStyles.bubbleOwn : voiceStyles.bubbleOther]}
    >
      <Text style={voiceStyles.icon}>{playing ? '⏸' : '▶'}</Text>
      <Text style={[voiceStyles.label, isOwn && voiceStyles.labelOwn]}>Voice message</Text>
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
  bubbleOwn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  bubbleOther: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  icon: {
    fontSize: 18,
  },
  label: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '500',
  },
  labelOwn: {
    color: '#FFFFFF',
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
}

function MessageBubble({ item, isOwn, currentUserId, onLongPress, onReact }: BubbleProps) {
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
          onLongPress={() => onLongPress(item.id)}
          activeOpacity={0.85}
          delayLongPress={350}
        >
          <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
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
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const router = useRouter();
  const { accessToken, user } = useAuthStore();
  const { socket } = useSocketStore();
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [reactionTarget, setReactionTarget] = useState<string | null>(null);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

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
    try {
      const { data } = await apiClient.get<{ messages: Message[]; nextCursor: string | null }>(
        `/api/v1/groups/${groupId}/messages?limit=50`,
      );
      setMessages(data.messages);
      setNextCursor(data.nextCursor);
    } catch {
      // silently fail — user sees empty list
    } finally {
      setLoading(false);
    }
  }, [groupId, accessToken]);

  useEffect(() => {
    void loadInitialMessages();
  }, [loadInitialMessages]);

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

  useEffect(() => {
    if (!socket) return;

    const handleMessage = (msg: Message) => {
      setMessages((prev) => [msg, ...prev]);
    };

    const handleReaction = (payload: { messageId: string; emoji: string; userId: string; action: 'add' | 'remove' }) => {
      setMessages((prev) =>
        prev.map((m) => {
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
        }),
      );
    };

    const handleTyping = (payload: { userId: string; displayName: string }) => {
      if (payload.userId === currentUserId) return;
      setTypingUser(payload.displayName);
      if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
      typingClearTimerRef.current = setTimeout(() => setTypingUser(null), 3000);
    };

    socket.on('group:message', handleMessage);
    socket.on('chat:react', handleReaction);
    socket.on('chat:typing', handleTyping);

    return () => {
      socket.off('group:message', handleMessage);
      socket.off('chat:react', handleReaction);
      socket.off('chat:typing', handleTyping);
    };
  }, [socket, currentUserId]);

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

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 500 || sending || !groupId || !accessToken) return;
    setSending(true);
    setInputText('');
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/messages`, { text: trimmed });
    } catch {
      setInputText(trimmed);
    } finally {
      setSending(false);
    }
  }, [sending, groupId, accessToken]);

  const handleSend = useCallback(() => sendMessage(inputText), [inputText, sendMessage]);

  const handleQuickReply = useCallback((text: string) => sendMessage(text), [sendMessage]);

  // ---------------------------------------------------------------------------
  // Voice recording
  // ---------------------------------------------------------------------------

  const startRecording = useCallback(async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      Alert.alert('Permission Required', 'Microphone access is required to send voice messages.');
      return;
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    recordingRef.current = recording;
    setIsRecording(true);
    setRecordingDuration(0);
    durationIntervalRef.current = setInterval(() => setRecordingDuration((d) => d + 1), 1000);
  }, []);

  const stopAndSendRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    setIsRecording(false);
    setRecordingDuration(0);
    const recording = recordingRef.current;
    recordingRef.current = null;
    await recording.stopAndUnloadAsync();
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    const uri = recording.getURI();
    if (!uri || !groupId || !accessToken) return;
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
      await apiClient.post(`/api/v1/groups/${groupId}/messages`, { type: 'voice', audioUrl });
    } catch {
      Alert.alert('Failed', 'Could not send voice message. Please try again.');
    } finally {
      setSending(false);
    }
  }, [groupId, accessToken, apiUrl]);

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
    if (!socket || !groupId || !user) return;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit('chat:typing', { groupId, displayName: user.displayName ?? 'Someone' });
    }, 1000);
  }, [socket, groupId, user]);

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  const handleLongPress = useCallback((messageId: string) => {
    setReactionTarget(messageId);
  }, []);

  const handleReact = useCallback((messageId: string, emoji: string) => {
    if (!socket || !groupId) return;
    const msg = messages.find((m) => m.id === messageId);
    const reaction = msg?.reactions?.find((r) => r.emoji === emoji);
    const alreadyReacted = reaction?.userIds.includes(currentUserId) ?? false;
    socket.emit('chat:react', {
      messageId,
      groupId,
      emoji,
      userId: currentUserId,
      action: alreadyReacted ? 'remove' : 'add',
    });
  }, [socket, groupId, messages, currentUserId]);

  const handleReactionSelect = useCallback((emoji: string) => {
    if (reactionTarget) handleReact(reactionTarget, emoji);
  }, [reactionTarget, handleReact]);

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
      />
    ),
    [currentUserId, handleLongPress, handleReact],
  );

  const keyExtractor = useCallback((item: Message) => item.id, []);
  const canSend = inputText.trim().length > 0 && inputText.length <= 500 && !sending;

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
          <Text style={styles.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>GROUP CHAT</Text>
        <View style={styles.headerRight} />
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
            ) : (
              <FlatList
                ref={flatListRef}
                data={messages}
                keyExtractor={keyExtractor}
                renderItem={renderMessage}
                inverted
                contentContainerStyle={styles.listContent}
                onEndReached={loadMoreMessages}
                onEndReachedThreshold={0.4}
                ListFooterComponent={
                  loadingMore ? (
                    <View style={styles.loadingMoreContainer}><SkeletonRow /></View>
                  ) : null
                }
                ListEmptyComponent={
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyIcon}>💬</Text>
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
              style={styles.quickReplyPill}
              onPress={() => handleQuickReply(qr.text)}
              accessibilityRole="button"
              accessibilityLabel={qr.label}
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
              placeholderTextColor={theme.colors.textSubtle}
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
            <Text style={styles.voiceBtnIcon}>{isRecording ? '⏹' : '🎤'}</Text>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
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
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 2,
  },
  backBtn: {
    color: theme.colors.textMuted,
    fontSize: 22,
    fontWeight: '600',
    width: 32,
  },
  headerRight: {
    width: 32,
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
    color: theme.colors.textSubtle,
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
    backgroundColor: theme.colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  avatarImage: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  avatarInitials: {
    color: theme.colors.textMuted,
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
    backgroundColor: theme.colors.accent,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderBottomLeftRadius: 4,
  },
  senderName: {
    color: theme.colors.textMuted,
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
    color: theme.colors.text,
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
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reactionPillOwn: {
    borderColor: theme.colors.accent,
    backgroundColor: 'rgba(220,20,60,0.12)',
  },
  reactionEmoji: {
    fontSize: 13,
  },
  reactionCount: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },

  // Typing indicator
  typingBar: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 4,
  },
  typingText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
  },

  // Quick replies
  quickRepliesContainer: {
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  quickRepliesContent: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
    gap: 8,
  },
  quickReplyPill: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  quickReplyText: {
    color: theme.colors.text,
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
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
  },
  inputWrapper: {
    flex: 1,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm + 4,
    paddingTop: theme.spacing.sm + 2,
    paddingBottom: theme.spacing.sm + 2,
    minHeight: 44,
    justifyContent: 'center',
  },
  textInput: {
    color: theme.colors.text,
    fontSize: 15,
    maxHeight: 120,
    padding: 0,
  },
  charCounter: {
    color: theme.colors.textSubtle,
    fontSize: 10,
    textAlign: 'right',
    marginTop: 4,
  },
  charCounterOver: {
    color: theme.colors.error,
  },

  // Voice button
  voiceBtn: {
    minWidth: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    flexDirection: 'row',
    paddingHorizontal: 8,
    gap: 4,
  },
  voiceBtnActive: {
    backgroundColor: 'rgba(220,20,60,0.15)',
    borderColor: theme.colors.accent,
  },
  voiceBtnIcon: {
    fontSize: 18,
  },
  recordingTimer: {
    color: theme.colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },

  // Send button
  sendBtn: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendBtnDisabled: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sendBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  sendBtnTextDisabled: {
    color: theme.colors.textSubtle,
  },
});

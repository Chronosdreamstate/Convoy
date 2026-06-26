/**
 * GroupChatScreen — real-time group text chat.
 * Full-screen dark chat UI with cursor-based pagination and socket live updates.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuthStore } from '../stores/authStore';
import { useSocketStore } from '../stores/socketStore';
import { SkeletonRow } from '../components/SkeletonLoader';
import { theme } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  text: string;
  createdAt: string;
}

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
// MessageBubble
// ---------------------------------------------------------------------------

interface BubbleProps {
  item: Message;
  isOwn: boolean;
}

function MessageBubble({ item, isOwn }: BubbleProps) {
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
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        {!isOwn && (
          <Text style={styles.senderName}>{item.displayName}</Text>
        )}
        <Text style={[styles.bubbleText, isOwn ? styles.bubbleTextOwn : styles.bubbleTextOther]}>
          {item.text}
        </Text>
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

  const flatListRef = useRef<FlatList<Message>>(null);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const loadInitialMessages = useCallback(async () => {
    if (!groupId || !accessToken) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/groups/${groupId}/messages?limit=50`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error('Failed to load messages');
      const data = (await res.json()) as { messages: Message[]; nextCursor: string | null };
      setMessages(data.messages);
      setNextCursor(data.nextCursor);
    } catch {
      // silently fail — user sees empty list
    } finally {
      setLoading(false);
    }
  }, [groupId, accessToken, apiUrl]);

  useEffect(() => {
    void loadInitialMessages();
  }, [loadInitialMessages]);

  const loadMoreMessages = useCallback(async () => {
    if (!groupId || !accessToken || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/groups/${groupId}/messages?before=${encodeURIComponent(nextCursor)}&limit=50`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error('Failed to load older messages');
      const data = (await res.json()) as { messages: Message[]; nextCursor: string | null };
      // Append older messages to the tail of the inverted list (i.e. the top visually)
      setMessages((prev) => [...prev, ...data.messages]);
      setNextCursor(data.nextCursor);
    } catch {
      // silently fail
    } finally {
      setLoadingMore(false);
    }
  }, [groupId, accessToken, nextCursor, loadingMore, apiUrl]);

  // ---------------------------------------------------------------------------
  // Socket: real-time new messages
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!socket) return;
    const handleMessage = (msg: Message) => {
      // Prepend to front so newest appears at bottom of inverted list
      setMessages((prev) => [msg, ...prev]);
    };
    socket.on('group:message', handleMessage);
    return () => {
      socket.off('group:message', handleMessage);
    };
  }, [socket]);

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed || trimmed.length > 500 || sending || !groupId || !accessToken) return;
    setSending(true);
    const snapshot = trimmed;
    setInputText('');
    try {
      await fetch(`${apiUrl}/api/v1/groups/${groupId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ text: snapshot }),
      });
      // The server will emit the socket event which updates the list
    } catch {
      // Restore on failure
      setInputText(snapshot);
    } finally {
      setSending(false);
    }
  }, [inputText, sending, groupId, accessToken, apiUrl]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const currentUserId = user?.id ?? '';

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble item={item} isOwn={item.userId === currentUserId} />
    ),
    [currentUserId],
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
                    <View style={styles.loadingMoreContainer}>
                      <SkeletonRow />
                    </View>
                  ) : null
                }
                ListEmptyComponent={
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>No messages yet. Say hi!</Text>
                  </View>
                }
                keyboardShouldPersistTaps="handled"
              />
            )}
          </View>
        </TouchableWithoutFeedback>

        {/* Input bar */}
        <View style={styles.inputBar}>
          <View style={styles.inputWrapper}>
            <TextInput
              style={styles.textInput}
              value={inputText}
              onChangeText={setInputText}
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
  },
  emptyText: {
    color: theme.colors.textSubtle,
    fontSize: 14,
  },

  // Message rows
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  messageRowLeft: {
    justifyContent: 'flex-start',
  },
  messageRowRight: {
    justifyContent: 'flex-end',
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
    maxWidth: '75%',
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

  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.sm,
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

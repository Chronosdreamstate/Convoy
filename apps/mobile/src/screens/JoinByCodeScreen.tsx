import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Clipboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { HapticService } from '../services/HapticService';
import { useGroupStore } from '../stores/groupStore';
import { useTheme, ThemeColors } from '../theme';

const CODE_LENGTH = 6;

// Text that always sits on the crimson accent fill (Join button) — stays
// light in both themes. `colors.text` is near-black in light mode, which
// would be unreadable on the accent background.
const ON_ACCENT = '#FFFFFF';

export default function JoinByCodeScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const { prefillCode } = useLocalSearchParams<{ prefillCode?: string }>();
  const inputRef = useRef<TextInput>(null);
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from deep link: convoy://join?code=XXXXXX
  useEffect(() => {
    if (prefillCode) {
      setCode(prefillCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH));
    }
  }, [prefillCode]);

  const handleChangeText = (text: string) => {
    setError(null);
    setCode(text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH));
  };

  const handlePaste = async () => {
    try {
      const text = await Clipboard.getString();
      if (text) handleChangeText(text);
    } catch {
      // non-fatal
    }
  };

  const handleJoin = async () => {
    if (code.length < CODE_LENGTH || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.post<{ id: string; name: string; adminId: string }>(
        '/api/v1/groups/join',
        { code },
      );
      HapticService.trigger('success');
      // Populate the group store now — ConvoyLobbyScreen reads adminId from here
      // to decide leader vs. member controls, and ConvoyScreen (the tab that
      // normally sets this) hasn't mounted yet at this point in the flow.
      useGroupStore.getState().setActiveGroupId(res.data.id);
      useGroupStore.getState().setGroupMeta({ name: res.data.name, adminId: res.data.adminId });
      router.replace({
        pathname: '/lobby/[groupId]' as never,
        params: { groupId: res.data.id, name: res.data.name },
      });
    } catch (err: unknown) {
      const response =
        err != null && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number; data?: { message?: string } } }).response
          : undefined;
      const status = response?.status ?? 0;
      const serverMessage = response?.data?.message;
      if (status === 404) {
        setError('Code not found — check with your convoy leader');
      } else if (status === 403) {
        setError('This convoy is invite-only — ask a member to send you a direct invite');
      } else if (status === 410) {
        // Server distinguishes "group has ended" from "code expired from
        // inactivity" with its own message — surface it verbatim rather than
        // collapsing both into one generic string.
        setError(serverMessage ?? 'This join code is no longer valid');
      } else if (status === 429) {
        setError("Too many attempts — wait a bit before trying again");
      } else if (status === 409) {
        setError("You're already in this group");
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardAvoid}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View>
            {/* Header */}
            <View style={styles.header}>
              <TouchableOpacity
                onPress={() => router.back()}
                style={styles.backBtn}
                accessibilityRole="button"
                accessibilityLabel="Go back"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.backText}>
                  <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
                </Text>
              </TouchableOpacity>
              <Text style={styles.title}>Join a Convoy</Text>
              <View style={styles.headerSpacer} />
            </View>

            {/* Illustration */}
            <View style={styles.illustration}>
              <View style={styles.carsRow}>
                <MaterialCommunityIcons name="car" size={44} color={colors.accent} />
                <MaterialCommunityIcons name="car" size={44} color={colors.accent} />
                <MaterialCommunityIcons name="car" size={44} color={colors.accent} />
              </View>
              <Text style={styles.hint}>Enter the code shared by your convoy leader</Text>
            </View>

            {/* Code input */}
            <View style={styles.inputSection}>
              <Pressable onPress={() => inputRef.current?.focus()}>
                <View style={[styles.inputWrapper, focused && styles.inputWrapperFocused]}>
                  <TextInput
                    ref={inputRef}
                    style={styles.codeInput}
                    value={code}
                    onChangeText={handleChangeText}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    maxLength={CODE_LENGTH}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    keyboardType="default"
                    returnKeyType="join"
                    onSubmitEditing={handleJoin}
                    placeholder="XXXXXX"
                    placeholderTextColor={colors.textSubtle}
                    accessibilityLabel="Convoy join code"
                  />
                </View>
              </Pressable>

              {/* Dots */}
              <View style={styles.dots}>
                {Array.from({ length: CODE_LENGTH }).map((_, i) => (
                  <Text key={i} style={[styles.dot, i < code.length && styles.dotFilled]}>
                    {i < code.length ? '●' : '○'}
                  </Text>
                ))}
              </View>

              {/* Paste */}
              <TouchableOpacity
                onPress={() => { void handlePaste(); }}
                style={styles.pasteBtn}
                accessibilityRole="button"
                accessibilityLabel="Paste code from clipboard"
              >
                <Text style={styles.pasteText}>
                  <Ionicons name="clipboard-outline" size={13} color={colors.textMuted} /> Paste Code
                </Text>
              </TouchableOpacity>

              {/* Inline error */}
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
          </View>

          {/* Join button */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.joinBtn, (code.length < CODE_LENGTH || loading) && styles.joinBtnDisabled]}
              onPress={() => { void handleJoin(); }}
              disabled={code.length < CODE_LENGTH || loading}
              accessibilityRole="button"
              accessibilityLabel="Join convoy"
            >
              {loading ? (
                <ActivityIndicator color={ON_ACCENT} size="small" />
              ) : (
                <Text style={styles.joinBtnText}>Join Convoy</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  keyboardAvoid: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    minWidth: 60,
    minHeight: 44,
    justifyContent: 'center',
  },
  backText: {
    color: colors.accent,
    fontSize: 17,
    fontWeight: '500',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  headerSpacer: {
    minWidth: 60,
  },
  illustration: {
    alignItems: 'center',
    paddingTop: 40,
    paddingBottom: 32,
    paddingHorizontal: 24,
  },
  carsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  inputSection: {
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  inputWrapper: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.border,
    paddingHorizontal: 20,
    paddingVertical: 14,
    width: 280,
    alignItems: 'center',
  },
  inputWrapperFocused: {
    borderColor: colors.accent,
  },
  codeInput: {
    color: colors.text,
    fontSize: 32,
    letterSpacing: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    textAlign: 'center',
    width: 240,
  },
  dots: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    marginBottom: 16,
  },
  dot: {
    fontSize: 14,
    color: colors.border,
  },
  dotFilled: {
    color: colors.accent,
  },
  pasteBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  pasteText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  joinBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  joinBtnDisabled: {
    opacity: 0.4,
  },
  joinBtnText: {
    color: ON_ACCENT,
    fontSize: 17,
    fontWeight: '700',
  },
  });
}

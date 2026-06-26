import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Clipboard,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { HapticService } from '../services/HapticService';

const CODE_LENGTH = 6;

export default function JoinByCodeScreen() {
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
      await apiClient.post('/api/v1/groups/join', { code });
      HapticService.trigger('success');
      router.replace('/(tabs)/map');
    } catch (err: unknown) {
      const status =
        err != null && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number } }).response?.status ?? 0
          : 0;
      if (status === 404) {
        setError('Code not found — check with your convoy leader');
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
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Join a Convoy</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Illustration */}
      <View style={styles.illustration}>
        <Text style={styles.cars}>🚗🚗🚗</Text>
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
              placeholder="XXXXXXXX"
              placeholderTextColor="#333333"
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
          <Text style={styles.pasteText}>📋 Paste Code</Text>
        </TouchableOpacity>

        {/* Inline error */}
        {error ? <Text style={styles.error}>{error}</Text> : null}
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
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.joinBtnText}>Join Convoy</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
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
    color: '#DC143C',
    fontSize: 17,
    fontWeight: '500',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: '#FFFFFF',
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
  cars: {
    fontSize: 60,
    letterSpacing: 8,
    marginBottom: 20,
  },
  hint: {
    color: '#888888',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  inputSection: {
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  inputWrapper: {
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#2A2A2A',
    paddingHorizontal: 20,
    paddingVertical: 14,
    width: 280,
    alignItems: 'center',
  },
  inputWrapperFocused: {
    borderColor: '#DC143C',
  },
  codeInput: {
    color: '#FFFFFF',
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
    color: '#2A2A2A',
  },
  dotFilled: {
    color: '#DC143C',
  },
  pasteBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  pasteText: {
    color: '#888888',
    fontSize: 14,
  },
  error: {
    color: '#EF4444',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
  footer: {
    position: 'absolute',
    bottom: 40,
    left: 24,
    right: 24,
  },
  joinBtn: {
    backgroundColor: '#DC143C',
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
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
});

/**
 * CreateGroupScreen — 3-step wizard for group creation.
 * Step 1: Name + vehicle focus
 * Step 2: Access type + gap threshold + PTT channel name
 * Step 3: Success — show join code, invite, start driving
 */

import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { apiClient } from '../services/apiClient';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const VEHICLE_TYPES = [
  { type: 'all', label: '🚗 All types' },
  { type: 'sports_car', label: '🏎️ Sports cars' },
  { type: 'suv', label: '🚙 SUVs & Trucks' },
  { type: 'motorcycle', label: '🏍️ Motorcycles' },
  { type: 'track_car', label: '🏁 Track days' },
];

const GAP_OPTIONS = [
  { label: '50 m', value: 50 },
  { label: '100 m', value: 100 },
  { label: '200 m', value: 200 },
  { label: '500 m', value: 500 },
];

interface CreatedGroup {
  id: string;
  name: string;
  joinCode: string;
}

export default function CreateGroupScreen() {
  const [step, setStep] = useState(1);
  const slideAnim = useRef(new Animated.Value(0)).current;

  // Step 1 state
  const [groupName, setGroupName] = useState('');
  const [vehicleType, setVehicleType] = useState('all');

  // Step 2 state
  const [accessType, setAccessType] = useState<'open' | 'invite_only'>('open');
  const [gapThreshold, setGapThreshold] = useState(100);
  const [pttChannelName, setPttChannelName] = useState('');

  // Step 3 state
  const [createdGroup, setCreatedGroup] = useState<CreatedGroup | null>(null);
  const [loading, setLoading] = useState(false);

  function goToStep(next: number) {
    const direction = next > step ? -1 : 1;
    Animated.sequence([
      Animated.spring(slideAnim, {
        toValue: direction * 40,
        useNativeDriver: true,
        tension: 120,
        friction: 8,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 120,
        friction: 8,
      }),
    ]).start();
    setStep(next);
  }

  async function handleCreate() {
    if (!groupName.trim()) {
      Alert.alert('Missing name', 'Enter a name for your convoy.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiClient.post<CreatedGroup>('/api/v1/groups', {
        name: groupName.trim(),
        gapThresholdM: gapThreshold,
        accessType,
        vehicleFocus: vehicleType !== 'all' ? vehicleType : undefined,
        pttChannelName: pttChannelName.trim() || undefined,
      });
      setCreatedGroup(res.data);
      goToStep(3);
    } catch {
      Alert.alert('Error', 'Could not create convoy. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleStartDriving() {
    router.replace('/(tabs)/convoy' as never);
  }

  async function handleInvite() {
    if (!createdGroup) return;
    try {
      await Share.share({
        title: 'Join my convoy on CONVOY',
        message: `Join my convoy "${createdGroup.name}" on CONVOY!\n\nCode: ${createdGroup.joinCode}\n\nDownload: convoy.app`,
      });
    } catch {
      // User cancelled share
    }
  }

  async function handleCopyCode() {
    if (!createdGroup) return;
    await Clipboard.setStringAsync(createdGroup.joinCode);
    Alert.alert('Copied!', `Code ${createdGroup.joinCode} copied to clipboard.`);
  }

  const progressWidth = `${(step / 3) * 100}%`;

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        {step > 1 && step < 3 ? (
          <TouchableOpacity onPress={() => goToStep(step - 1)} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Go back">
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.backBtn} />
        )}
        <Text style={styles.headerTitle}>CREATE CONVOY</Text>
        {step < 3 ? (
          <TouchableOpacity onPress={() => router.back()} style={styles.cancelBtn} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={styles.cancelBtnText}>✕</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.cancelBtn} />
        )}
      </View>

      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <Animated.View style={[styles.progressFill, { width: progressWidth as never }]} />
      </View>
      <Text style={styles.stepLabel}>Step {step} of 3</Text>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={120}
      >
        <Animated.View style={[styles.stepContainer, { transform: [{ translateX: slideAnim }] }]}>

          {/* ── Step 1: Basics ─────────────────────────────── */}
          {step === 1 && (
            <View style={styles.stepContent}>
              <Text style={styles.stepHeadline}>What's your crew called?</Text>
              <TextInput
                style={styles.nameInput}
                placeholder="e.g. Sunday Rally"
                placeholderTextColor="#555"
                value={groupName}
                onChangeText={setGroupName}
                autoFocus
                maxLength={50}
                accessibilityLabel="Group name"
              />
              <Text style={styles.charCount}>{groupName.length}/50</Text>

              <Text style={styles.fieldLabel}>What does your crew drive?</Text>
              <View style={styles.pillGrid}>
                {VEHICLE_TYPES.map((v) => (
                  <TouchableOpacity
                    key={v.type}
                    style={[styles.pill, vehicleType === v.type && styles.pillActive]}
                    onPress={() => setVehicleType(v.type)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: vehicleType === v.type }}
                    accessibilityLabel={v.label}
                  >
                    <Text style={[styles.pillText, vehicleType === v.type && styles.pillTextActive]}>
                      {v.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* ── Step 2: Settings ───────────────────────────── */}
          {step === 2 && (
            <View style={styles.stepContent}>
              <Text style={styles.stepHeadline}>Convoy settings</Text>

              <Text style={styles.fieldLabel}>Who can join?</Text>
              <View style={styles.pillRow}>
                {([
                  { value: 'open', label: '🌐  Public' },
                  { value: 'invite_only', label: '🔒  Invite Only' },
                ] as const).map((opt) => (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.pill, styles.pillHalf, accessType === opt.value && styles.pillActive]}
                    onPress={() => setAccessType(opt.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: accessType === opt.value }}
                    accessibilityLabel={opt.label}
                  >
                    <Text style={[styles.pillText, accessType === opt.value && styles.pillTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Gap alert distance</Text>
              <View style={styles.pillRow}>
                {GAP_OPTIONS.map((opt) => (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.pill, gapThreshold === opt.value && styles.pillActive]}
                    onPress={() => setGapThreshold(opt.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: gapThreshold === opt.value }}
                    accessibilityLabel={`${opt.label} gap threshold`}
                  >
                    <Text style={[styles.pillText, gapThreshold === opt.value && styles.pillTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.fieldLabel}>PTT channel name (optional)</Text>
              <TextInput
                style={styles.channelInput}
                placeholder="e.g. Sunday Crew, Track Day Radio"
                placeholderTextColor="#555"
                value={pttChannelName}
                onChangeText={setPttChannelName}
                maxLength={40}
                accessibilityLabel="PTT channel name"
              />
            </View>
          )}

          {/* ── Step 3: Success ────────────────────────────── */}
          {step === 3 && createdGroup && (
            <View style={[styles.stepContent, styles.successContent]}>
              <Text style={styles.successEmoji}>🎉</Text>
              <Text style={styles.successHeadline}>Your convoy is ready!</Text>
              <Text style={styles.successGroupName}>{createdGroup.name}</Text>

              <Text style={styles.fieldLabel}>Share this code with your crew</Text>
              <View style={styles.codeCard}>
                <Text style={styles.joinCode}>{createdGroup.joinCode}</Text>
              </View>

              <View style={styles.codeActions}>
                <TouchableOpacity style={styles.codeActionBtn} onPress={handleCopyCode} accessibilityRole="button" accessibilityLabel="Copy join code">
                  <Text style={styles.codeActionText}>📋 Copy Code</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.codeActionBtn} onPress={handleInvite} accessibilityRole="button" accessibilityLabel="Invite friends">
                  <Text style={styles.codeActionText}>📨 Invite Friends</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </Animated.View>
      </KeyboardAvoidingView>

      {/* Bottom action button */}
      <View style={styles.bottomBar}>
        {step === 1 && (
          <TouchableOpacity
            style={[styles.nextBtn, !groupName.trim() && styles.nextBtnDisabled]}
            onPress={() => goToStep(2)}
            disabled={!groupName.trim()}
            accessibilityRole="button"
            accessibilityLabel="Next step"
          >
            <Text style={styles.nextBtnText}>Next →</Text>
          </TouchableOpacity>
        )}
        {step === 2 && (
          <TouchableOpacity
            style={[styles.nextBtn, loading && styles.nextBtnDisabled]}
            onPress={handleCreate}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Create convoy"
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.nextBtnText}>Create Convoy</Text>
            }
          </TouchableOpacity>
        )}
        {step === 3 && (
          <TouchableOpacity
            style={styles.nextBtn}
            onPress={handleStartDriving}
            accessibilityRole="button"
            accessibilityLabel="Start driving"
          >
            <Text style={styles.nextBtnText}>🚗 Start Driving</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 2 },
  backBtn: { width: 64 },
  backBtnText: { color: '#DC143C', fontSize: 14, fontWeight: '600' },
  cancelBtn: { width: 64, alignItems: 'flex-end' },
  cancelBtnText: { color: '#888', fontSize: 18 },
  progressTrack: {
    height: 3,
    backgroundColor: '#2A2A2A',
    marginHorizontal: 16,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 3,
    backgroundColor: '#DC143C',
    borderRadius: 2,
  },
  stepLabel: { color: '#888', fontSize: 12, textAlign: 'center', marginTop: 8, marginBottom: 4 },
  stepContainer: { flex: 1 },
  stepContent: { flex: 1, paddingHorizontal: 20, paddingTop: 24 },
  stepHeadline: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 20 },
  nameInput: {
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    color: '#fff',
    fontSize: 22,
    padding: 16,
    marginBottom: 4,
  },
  charCount: { color: '#555', fontSize: 12, textAlign: 'right', marginBottom: 24 },
  fieldLabel: { color: '#888', fontSize: 12, fontWeight: '600', letterSpacing: 1, marginBottom: 12, marginTop: 8 },
  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  pill: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  pillHalf: { flex: 1 },
  pillActive: { backgroundColor: '#1A0005', borderColor: '#DC143C' },
  pillText: { color: '#888', fontSize: 14 },
  pillTextActive: { color: '#DC143C', fontWeight: '600' },
  channelInput: {
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    color: '#fff',
    fontSize: 16,
    padding: 14,
    marginTop: 4,
  },
  successContent: { alignItems: 'center', paddingTop: 40 },
  successEmoji: { fontSize: 64, marginBottom: 12 },
  successHeadline: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 4 },
  successGroupName: { color: '#888', fontSize: 16, marginBottom: 32 },
  codeCard: {
    backgroundColor: '#1A0005',
    borderWidth: 1.5,
    borderColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 40,
    marginBottom: 20,
  },
  joinCode: {
    color: '#DC143C',
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: 8,
    fontVariant: ['tabular-nums'],
  },
  codeActions: { flexDirection: 'row', gap: 12 },
  codeActionBtn: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  codeActionText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  bottomBar: { padding: 20, paddingBottom: 32 },
  nextBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextBtnDisabled: { opacity: 0.4 },
  nextBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});

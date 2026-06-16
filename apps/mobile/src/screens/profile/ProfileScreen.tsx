import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  Switch,
  Alert,
} from 'react-native';
import { apiClient } from '../../services/apiClient';

interface Profile {
  id: string;
  displayName: string;
  phoneNumber: string | null;
  email: string | null;
  avatarUrl: string | null;
  pttCallsign: string | null;
  privacy: 'open' | 'invite_only';
}

export default function ProfileScreen() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable fields
  const [displayName, setDisplayName] = useState('');
  const [pttCallsign, setPttCallsign] = useState('');
  const [privacy, setPrivacy] = useState<'open' | 'invite_only'>('open');
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<Profile>('/api/v1/users/me');
      const p = response.data;
      setProfile(p);
      setDisplayName(p.displayName);
      setPttCallsign(p.pttCallsign ?? '');
      setPrivacy(p.privacy);
      setIsDirty(false);
    } catch {
      setError('Failed to load profile. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!isDirty) return;

    setIsSaving(true);
    setError(null);
    try {
      const response = await apiClient.patch<Profile>('/api/v1/users/me', {
        displayName: displayName.trim() || undefined,
        pttCallsign: pttCallsign.trim() || null,
        privacy,
      });
      setProfile(response.data);
      setIsDirty(false);
      Alert.alert('Saved', 'Your profile has been updated.');
    } catch {
      setError('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const markDirty = () => setIsDirty(true);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#FF6B00" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Profile</Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Identity</Text>

          <Text style={styles.label}>Display Name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={(v) => { setDisplayName(v); markDirty(); }}
            placeholder="Your display name"
            placeholderTextColor="#555"
            maxLength={100}
            accessibilityLabel="Display name input"
          />

          <Text style={[styles.label, styles.labelSpacing]}>PTT Callsign</Text>
          <TextInput
            style={styles.input}
            value={pttCallsign}
            onChangeText={(v) => { setPttCallsign(v); markDirty(); }}
            placeholder="e.g. Alpha-1 (optional)"
            placeholderTextColor="#555"
            maxLength={50}
            accessibilityLabel="PTT callsign input"
          />

          {profile?.email ? (
            <View style={styles.readonlyRow}>
              <Text style={styles.label}>Email</Text>
              <Text style={styles.readonlyValue}>{profile.email}</Text>
            </View>
          ) : null}

          {profile?.phoneNumber ? (
            <View style={styles.readonlyRow}>
              <Text style={styles.label}>Phone</Text>
              <Text style={styles.readonlyValue}>{profile.phoneNumber}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Privacy</Text>

          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text style={styles.switchTitle}>Open to Friend Requests</Text>
              <Text style={styles.switchSubtitle}>
                {privacy === 'open'
                  ? 'Anyone can send you a friend request'
                  : 'Only people you invite can send requests'}
              </Text>
            </View>
            <Switch
              value={privacy === 'open'}
              onValueChange={(val) => {
                setPrivacy(val ? 'open' : 'invite_only');
                markDirty();
              }}
              trackColor={{ false: '#333', true: '#FF6B00' }}
              thumbColor="#FFFFFF"
              accessibilityLabel="Open to friend requests toggle"
            />
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, (!isDirty || isSaving) && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={!isDirty || isSaving}
          accessibilityRole="button"
          accessibilityLabel="Save profile"
        >
          {isSaving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.saveButtonText}>Save Changes</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 48,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 24,
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    color: '#AAAAAA',
    marginBottom: 4,
  },
  labelSpacing: {
    marginTop: 12,
  },
  input: {
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#FFFFFF',
  },
  readonlyRow: {
    marginTop: 12,
  },
  readonlyValue: {
    fontSize: 15,
    color: '#DDDDDD',
    paddingVertical: 6,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  switchLabel: {
    flex: 1,
    paddingRight: 16,
  },
  switchTitle: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  switchSubtitle: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  errorText: {
    color: '#FF4444',
    fontSize: 13,
    marginBottom: 16,
  },
  saveButton: {
    backgroundColor: '#FF6B00',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});

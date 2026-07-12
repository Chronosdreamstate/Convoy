import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import PTTTutorialPulse from '../../components/PTTTutorialPulse';

// Text that always sits on the crimson accent fill — stays light in both themes.
const ON_ACCENT = '#FFFFFF';

export default function PTTTutorialScreen() {
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const goToFindGroup = () => {
    router.replace('/(onboarding)/find-group' as never);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.topSection}>
          {/* Mock PTT button with pulse ring (static under OS reduce-motion) */}
          <PTTTutorialPulse />

          <Text style={styles.holdToTalk}>Hold to Talk</Text>
          <Text style={styles.subText}>
            {'During a convoy, press and hold the button\nto broadcast your voice to the group.'}
          </Text>
        </View>

        <View style={styles.bottomSection}>
          <TouchableOpacity
            style={styles.gotItBtn}
            onPress={goToFindGroup}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Got it"
          >
            <Text style={styles.gotItText}>Got it!</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={goToFindGroup}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Skip tutorial"
          >
            <Text style={styles.skipText}>Skip tutorial</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.bg },
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 24,
      paddingVertical: 48,
    },
    topSection: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 24,
    },
    holdToTalk: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.text,
      textAlign: 'center',
    },
    subText: {
      fontSize: 15,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
    },
    bottomSection: {
      width: '100%',
      alignItems: 'center',
      gap: 16,
    },
    gotItBtn: {
      width: '100%',
      backgroundColor: theme.colors.accent,
      borderRadius: 12,
      paddingVertical: 16,
      alignItems: 'center',
    },
    gotItText: {
      fontSize: 16,
      fontWeight: '700',
      color: ON_ACCENT,
    },
    skipText: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
  });
}

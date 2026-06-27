import AsyncStorage from '@react-native-async-storage/async-storage';

export type OnboardingStep = 'vehicle' | 'group' | 'complete';

export const onboardingState = {
  async getCompletedSteps(): Promise<OnboardingStep[]> {
    const saved = await AsyncStorage.getItem('@convoy/onboarding_completed');
    return saved ? (JSON.parse(saved) as OnboardingStep[]) : [];
  },

  async markComplete(step: OnboardingStep): Promise<void> {
    const steps = await this.getCompletedSteps();
    if (!steps.includes(step)) {
      steps.push(step);
      await AsyncStorage.setItem('@convoy/onboarding_completed', JSON.stringify(steps));
    }
  },

  async getSkippedSteps(): Promise<OnboardingStep[]> {
    const saved = await AsyncStorage.getItem('@convoy/onboarding_skipped');
    return saved ? (JSON.parse(saved) as OnboardingStep[]) : [];
  },

  async markSkipped(step: OnboardingStep): Promise<void> {
    const steps = await this.getSkippedSteps();
    if (!steps.includes(step)) {
      steps.push(step);
      await AsyncStorage.setItem('@convoy/onboarding_skipped', JSON.stringify(steps));
    }
  },

  async hasIncompleteSteps(): Promise<boolean> {
    const [skipped, completed] = await Promise.all([
      this.getSkippedSteps(),
      this.getCompletedSteps(),
    ]);
    return skipped.some((s) => !completed.includes(s));
  },

  async reset(): Promise<void> {
    await AsyncStorage.multiRemove([
      '@convoy/onboarding_completed',
      '@convoy/onboarding_skipped',
    ]);
  },
};

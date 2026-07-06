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

  /**
   * Which onboarding route a returning-but-incomplete user should land on,
   * based on which of the tracked steps ('vehicle', 'group') they've already
   * completed or explicitly skipped. A step counts as "done" either way —
   * skipping is a deliberate choice not to be undone by re-showing the screen.
   *
   * 'ptt-tutorial' sits between 'vehicle' and 'group' in the screen flow but
   * has no persisted state of its own (it's a non-interactive interstitial),
   * so finishing 'vehicle' resumes there rather than at a tracked step.
   *
   * Returns null when every tracked step is already done — callers should
   * not enter the onboarding stack at all in that case.
   */
  async getResumeRoute(): Promise<string | null> {
    const [completed, skipped] = await Promise.all([
      this.getCompletedSteps(),
      this.getSkippedSteps(),
    ]);
    const isDone = (step: OnboardingStep) => completed.includes(step) || skipped.includes(step);

    if (!isDone('vehicle')) return '/(onboarding)/vehicle';
    if (!isDone('group')) return '/(onboarding)/ptt-tutorial';
    return null;
  },

  async reset(): Promise<void> {
    await AsyncStorage.multiRemove([
      '@convoy/onboarding_completed',
      '@convoy/onboarding_skipped',
    ]);
  },
};

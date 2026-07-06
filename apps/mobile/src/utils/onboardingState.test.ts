/**
 * Unit tests for onboardingState — Task 58 (onboarding resume)
 *
 * Validates:
 *  - getCompletedSteps / markComplete / getSkippedSteps / markSkipped persist
 *    correctly through the (globally mocked) AsyncStorage.
 *  - getResumeRoute() sends a returning-but-incomplete user to the correct
 *    NEXT step instead of always restarting onboarding from the beginning.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { onboardingState } from './onboardingState';

describe('onboardingState', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  describe('getCompletedSteps / markComplete', () => {
    it('returns an empty array when nothing has been completed', async () => {
      expect(await onboardingState.getCompletedSteps()).toEqual([]);
    });

    it('records a completed step and does not duplicate it', async () => {
      await onboardingState.markComplete('vehicle');
      await onboardingState.markComplete('vehicle');

      expect(await onboardingState.getCompletedSteps()).toEqual(['vehicle']);
    });
  });

  describe('getSkippedSteps / markSkipped', () => {
    it('records a skipped step and does not duplicate it', async () => {
      await onboardingState.markSkipped('group');
      await onboardingState.markSkipped('group');

      expect(await onboardingState.getSkippedSteps()).toEqual(['group']);
    });
  });

  describe('getResumeRoute', () => {
    it('sends a brand new user (no steps done) to the first step', async () => {
      const route = await onboardingState.getResumeRoute();
      expect(route).toBe('/(onboarding)/vehicle');
    });

    it('resumes at the ptt-tutorial screen when vehicle is completed but group is not', async () => {
      await onboardingState.markComplete('vehicle');

      const route = await onboardingState.getResumeRoute();
      expect(route).toBe('/(onboarding)/ptt-tutorial');
    });

    it('resumes at the ptt-tutorial screen when vehicle was skipped rather than completed', async () => {
      await onboardingState.markSkipped('vehicle');

      const route = await onboardingState.getResumeRoute();
      expect(route).toBe('/(onboarding)/ptt-tutorial');
    });

    it('returns null once both tracked steps are completed', async () => {
      await onboardingState.markComplete('vehicle');
      await onboardingState.markComplete('group');

      expect(await onboardingState.getResumeRoute()).toBeNull();
    });

    it('returns null once both tracked steps are skipped', async () => {
      await onboardingState.markSkipped('vehicle');
      await onboardingState.markSkipped('group');

      expect(await onboardingState.getResumeRoute()).toBeNull();
    });

    it('returns null with a mix of completed and skipped steps', async () => {
      await onboardingState.markComplete('vehicle');
      await onboardingState.markSkipped('group');

      expect(await onboardingState.getResumeRoute()).toBeNull();
    });
  });

  describe('reset', () => {
    it('clears completed and skipped steps so resume starts over from the first step', async () => {
      await onboardingState.markComplete('vehicle');
      await onboardingState.markComplete('group');

      await onboardingState.reset();

      expect(await onboardingState.getCompletedSteps()).toEqual([]);
      expect(await onboardingState.getSkippedSteps()).toEqual([]);
      expect(await onboardingState.getResumeRoute()).toBe('/(onboarding)/vehicle');
    });
  });
});

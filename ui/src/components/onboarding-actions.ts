let onboardingActionSession = 0;

export function invalidateOnboardingActions(): void {
  onboardingActionSession += 1;
}

export function readOnboardingActionSession(): number {
  return onboardingActionSession;
}

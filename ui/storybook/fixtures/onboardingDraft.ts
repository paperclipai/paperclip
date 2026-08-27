import { ONBOARDING_STORAGE_KEY } from "@/components/OnboardingWizard";

/**
 * The onboarding draft, as the wizard stories need to write it.
 *
 * `localStorage` is per-origin, so every story in a Storybook session shares
 * one. A story that seeds a draft and walks away leaves it for the next one:
 * the wizard restores a saved step ahead of whatever step that story asked for,
 * and the reviewer gets a screen they did not click on. So seeding and clearing
 * are a pair, and they live here rather than inline so the pairing is testable.
 *
 * The key is imported rather than restated. It is the wizard's, and a second
 * copy of a storage key is a bug waiting for the first one to be renamed.
 */

export const STORYBOOK_COMPANY_ID = "company-storybook";
export const STORYBOOK_AGENT_ID = "agent-storybook";

export function seedOnboardingDraft(step: 3 | 4 | 5): void {
  window.localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      step,
      companyName: "Paperclip Storybook",
      agentName: "Darnold",
      agentRole: "general",
      adapterType: "claude_code",
      createdCompanyId: STORYBOOK_COMPANY_ID,
      createdCompanyPrefix: "PAP",
      // Only from the review step onward. Before the hire there is no agent, and
      // filling this in earlier would hide the incomplete-state guard step 5
      // shows when it is reached without one.
      createdAgentId: step >= 5 ? STORYBOOK_AGENT_ID : "",
    }),
  );
}

export function clearOnboardingDraft(): void {
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
}

export function readOnboardingDraft(): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

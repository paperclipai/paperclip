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

/** Where the agent arc begins. Every story in it enters here — see below. */
export const ONBOARDING_ARC_ENTRY_STEP = 3;

/**
 * The draft a run holds when it arrives at the agent arc.
 *
 * It seeds the *entry* step and nothing further on purpose. The wizard offers
 * Back only on a step it walked forward into — `currentStep > entryStep`, and
 * `entryStep` is captured once at mount from this very draft — so a story that
 * seeds step 4 or 5 directly renders those steps permanently without their Back
 * button. Stories that want a later step click their way to it instead.
 *
 * `createdAgentId` is therefore absent rather than seeded: the hire happens for
 * real, through the fixtured route, which is also what keeps step 5's
 * `launchStateIncomplete` guard honest instead of painted over.
 */
export function seedOnboardingDraft(): void {
  window.localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      step: ONBOARDING_ARC_ENTRY_STEP,
      companyName: "Paperclip Storybook",
      agentName: "Darnold",
      agentRole: "general",
      // No `adapterType`. This draft describes a run standing on step 3, and a
      // run that has not reached the connect step cannot have chosen a source
      // there — seeding one made every arc story arrive with Claude Code already
      // picked, which is precisely the preselection the step was changed to stop
      // doing. Stories that need a source pick one, the way a customer does.
      //
      // (It read `claude_code` before that, which is no adapter at all: the step
      // recovered by falling back, and the hire would have posted a type the
      // server does not know.)
      createdCompanyId: STORYBOOK_COMPANY_ID,
      createdCompanyPrefix: "PAP",
      createdAgentId: "",
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

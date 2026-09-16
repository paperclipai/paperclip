// Deterministic, template-driven greeting seeded as an agent-authored comment on
// the onboarding first task. No LLM call: the server posts a fixed welcome from
// greeting.md so the user lands on a waiting greeting instead of a right-aligned
// "user" bubble showing the agent's own seeded instructions.
//
// The wording lives in server/src/onboarding-assets/first-task/greeting.md so the
// board can edit it without touching TypeScript; this module only fills the
// {{agentName}} / {{organizationName}} placeholders (see
// onboarding-first-task-assets.ts).

import { renderOnboardingFirstTaskGreeting } from "./onboarding-first-task-assets.js";

export const ONBOARDING_GREETING_AUTHORIZATION_REASON = "onboarding first-task greeting";

export async function renderOnboardingGreeting(input: {
  agentName?: string | null;
  organizationName?: string | null;
}): Promise<string> {
  return renderOnboardingFirstTaskGreeting({
    agentName: input.agentName,
    organizationName: input.organizationName,
  });
}

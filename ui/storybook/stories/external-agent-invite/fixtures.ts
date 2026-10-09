import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { buildDotSetupPrompt } from "@/lib/dot-setup-prompt";

// Deliberately non-routable fixture URLs/codes; never store real invitations in stories.
export const externalInvitePrompt = buildAgentOnboardingPrompt({
  onboardingTextUrl: "https://paperclip.example/invite/storybook/onboarding.txt",
});

export function dotInvitePrompt(generation = 1) {
  const current = buildDotSetupPrompt({
    companyId: "company-storybook", agentId: "dot-storybook",
    resourceUrl: "https://paperclip.example/mcp/runner/dot",
    pairingCode: `STORYBOOK-NOT-A-REAL-CODE-${generation}`,
    expiresAt: "15 minutes after this invitation is created",
  });
  return current;
}

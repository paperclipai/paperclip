// Deterministic, template-driven greeting seeded as an agent-authored comment on
// the onboarding first task. No LLM call: it reflects back the onboarding context
// (team name + goals) so the user lands on a waiting greeting instead of a
// right-aligned "user" bubble showing the agent's own seeded instructions.

export const ONBOARDING_GREETING_AUTHORIZATION_REASON = "onboarding first-task greeting";

export function buildOnboardingGreeting(input: {
  agentName?: string | null;
  teamName?: string | null;
  goals?: string | null;
}): string {
  const agentName = input.agentName?.trim();
  const goals = input.goals?.replace(/\s+/g, " ").trim();

  // Introduce the agent by the name the user chose in onboarding when we have
  // it, so the first message reads as coming from *their* first teammate rather
  // than a generic agent. Fall back to the generic phrasing otherwise.
  const identity = agentName
    ? `Welcome! I'm ${agentName}, your first agent teammate on Paperclip.`
    : "Welcome! I'm your first agent teammate on Paperclip.";

  const lines: string[] = [];
  lines.push(identity);

  if (goals) {
    lines.push("");
    lines.push("Here's what I understand you're aiming for:");
    lines.push("");
    lines.push(`> ${goals}`);
  }

  lines.push("");
  lines.push(
    "I want to gather more context so I can come up with a plan and propose a team of agents to help execute it. I'm putting together a few focused questions so we can settle on a concrete goal to tackle first. Please give me one moment...",
  );

  return lines.join("\n");
}

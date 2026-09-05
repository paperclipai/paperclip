import fs from "node:fs/promises";

// Everything the onboarding first agent is told lives as plain markdown under
// server/src/onboarding-assets/first-task/ so the board can edit the wording
// without touching TypeScript. These loaders read those files at runtime the
// same way loadDefaultAgentInstructionsBundle reads default/ and ceo/ (the build
// copies src/onboarding-assets/. into dist/onboarding-assets/), and fill the
// {{agentName}} / {{organizationName}} / {{proposalStep}} placeholders.

export interface OnboardingFirstTaskPlaceholders {
  agentName?: string | null;
  organizationName?: string | null;
}

function resolveFirstTaskAssetUrl(relativePath: string) {
  return new URL(`../onboarding-assets/first-task/${relativePath}`, import.meta.url);
}

async function loadFirstTaskAsset(relativePath: string): Promise<string> {
  return fs.readFile(resolveFirstTaskAssetUrl(relativePath), "utf8");
}

// Fill the shared name/organization placeholders. When the agent has no name the
// greeting must read "I'm your first agent teammate" rather than leaving a gap,
// so we drop the placeholder together with its trailing separator — matching the
// historical buildOnboardingGreeting behaviour.
export function fillFirstTaskPlaceholders(
  text: string,
  { agentName, organizationName }: OnboardingFirstTaskPlaceholders,
): string {
  let out = text;
  const name = agentName?.trim();
  if (name) {
    out = out.split("{{agentName}}").join(name);
  } else {
    out = out
      .split("{{agentName}}, ").join("")
      .split("{{agentName}} ").join("")
      .split("{{agentName}}").join("");
  }
  const org = organizationName?.trim();
  out = out.split("{{organizationName}}").join(org && org.length > 0 ? org : "your organization");
  return out;
}

// Layer C — the deterministic greeting posted as the agent on the first task.
export async function renderOnboardingFirstTaskGreeting(
  placeholders: OnboardingFirstTaskPlaceholders,
): Promise<string> {
  const template = await loadFirstTaskAsset("greeting.md");
  return fillFirstTaskPlaceholders(template, placeholders).trim();
}

// Layer A — the first task's description. brief.md carries {{proposalStep}},
// which is replaced by the proposal file the toggle selects.
export async function buildOnboardingFirstTaskBrief(options: {
  usePlanProposal: boolean;
}): Promise<string> {
  const [brief, proposal] = await Promise.all([
    loadFirstTaskAsset("brief.md"),
    loadFirstTaskAsset(options.usePlanProposal ? "proposal-plan.md" : "proposal-confirmation.md"),
  ]);
  const proposalStep = proposal.replace(/\s+$/, "");
  // Use a function replacement so `$` sequences in the proposal text are not
  // interpreted as replacement patterns.
  return brief.replace("{{proposalStep}}", () => proposalStep).trim();
}

// Layer B — the chief-of-staff persona seeded over the first agent's entry
// instruction file at hire time.
export async function renderChiefOfStaffPersona(
  placeholders: OnboardingFirstTaskPlaceholders,
): Promise<string> {
  const template = await loadFirstTaskAsset("chief-of-staff/AGENTS.md");
  return fillFirstTaskPlaceholders(template, placeholders);
}

// The instruction bundle for the onboarding first agent: the chief-of-staff
// persona as the entry AGENTS.md. The generic execution contract
// (default/AGENTS.md) is still appended on every run by the runner, unchanged.
export async function buildOnboardingFirstAgentInstructionsBundle(
  placeholders: OnboardingFirstTaskPlaceholders,
): Promise<{ files: Record<string, string>; entryFile: string }> {
  const persona = await renderChiefOfStaffPersona(placeholders);
  return { files: { "AGENTS.md": persona }, entryFile: "AGENTS.md" };
}

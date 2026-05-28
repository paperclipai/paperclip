import fs from "node:fs/promises";
import { isFoundingAgentRole } from "@valadrien-os/shared";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  onboarding: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  // Founding agents (CEO, Chief of Staff, CTO) all currently use the CEO
  // bundle because they share the same platform capabilities (manage company
  // settings, create other agents, assign tasks, approve work). A follow-up
  // (see doc/plans/2026-05-28-founding-role-instruction-bundles.md) will give
  // Chief of Staff and CTO their own bundles tailored to their executive
  // function.
  if (isFoundingAgentRole(role)) return "ceo";
  if (role === "onboarding") return "onboarding";
  return "default";
}

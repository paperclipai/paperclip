import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  architect: ["AGENTS.md"],
  "code-reviewer": ["AGENTS.md"],
  "wiring-expert": ["AGENTS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

// Seed bundles that are routed by the agent's derived urlKey (normalized name),
// not its `role` column. Gate agents carry a generic role (architect/wiring →
// "engineer", code-reviewer → "qa") but a distinct identity in their name, so the
// seed must key on identity. Only these three keys are urlKey-routable; "default"
// and "ceo" stay role-driven so an agent merely named "Default"/"CEO" cannot
// hijack a bundle.
const IDENTITY_ROUTABLE_BUNDLE_ROLES = new Set<DefaultAgentBundleRole>([
  "architect",
  "code-reviewer",
  "wiring-expert",
]);

function isIdentityRoutableBundleRole(value: string): value is DefaultAgentBundleRole {
  return IDENTITY_ROUTABLE_BUNDLE_ROLES.has(value as DefaultAgentBundleRole);
}

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

export function resolveDefaultAgentInstructionsBundleRole(
  role: string,
  urlKey?: string | null,
): DefaultAgentBundleRole {
  // Identity (derived urlKey) wins for the gate roles: a Code Reviewer carries
  // role "qa" but must seed the code-reviewer bundle, not the generic default.
  if (typeof urlKey === "string" && isIdentityRoutableBundleRole(urlKey)) {
    return urlKey;
  }
  return role === "ceo" ? "ceo" : "default";
}

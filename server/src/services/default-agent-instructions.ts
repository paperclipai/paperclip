import fs from "node:fs/promises";

const ROLE_BUNDLE_FILES = ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"] as const;

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ROLE_BUNDLE_FILES,
  ceo: ROLE_BUNDLE_FILES,
  cto: ROLE_BUNDLE_FILES,
  architect: ROLE_BUNDLE_FILES,
  cmo: ROLE_BUNDLE_FILES,
  cfo: ROLE_BUNDLE_FILES,
  engineer: ROLE_BUNDLE_FILES,
  designer: ROLE_BUNDLE_FILES,
  pm: ROLE_BUNDLE_FILES,
  qa: ROLE_BUNDLE_FILES,
  devops: ROLE_BUNDLE_FILES,
  researcher: ROLE_BUNDLE_FILES,
  general: ROLE_BUNDLE_FILES,
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
  if (role in DEFAULT_AGENT_BUNDLE_FILES) {
    return role as DefaultAgentBundleRole;
  }
  return "default";
}

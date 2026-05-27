import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
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
  const bundle = Object.fromEntries(entries);
  // For non-CEO roles, the Wake Pre-flight short-circuit protocol (BLO-6151)
  // is composed onto AGENTS.md at materialization time so new agents land on
  // disk with the protocol already in place. CEO has its own multi-file bundle
  // and is not part of the sweep-wake population that this protocol targets.
  if (role !== "ceo" && bundle["AGENTS.md"]) {
    const preflight = await loadWakePreflightContent();
    bundle["AGENTS.md"] = composeAgentsMdWithPreflight(preflight, bundle["AGENTS.md"]);
  }
  return bundle;
}

export function composeAgentsMdWithPreflight(preflight: string, body: string): string {
  if (body.trimStart().startsWith("## Wake Pre-flight")) return body;
  return `${preflight.trimEnd()}\n\n${body}`;
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "ceo" ? "ceo" : "default";
}

const WAKE_PREFLIGHT_URL = new URL(
  "../onboarding-assets/_shared/WAKE-PREFLIGHT.md",
  import.meta.url,
);

let wakePreflightCache: Promise<string> | null = null;

export async function loadWakePreflightContent(): Promise<string> {
  if (!wakePreflightCache) {
    wakePreflightCache = fs.readFile(WAKE_PREFLIGHT_URL, "utf8");
  }
  return wakePreflightCache;
}

export function clearWakePreflightCache(): void {
  wakePreflightCache = null;
}

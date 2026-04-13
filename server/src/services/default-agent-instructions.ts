import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  trading: ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"],
  dev: ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"],
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

/** Trading-team roles that get the `trading/` instruction template. */
const TRADING_ROLES = new Set([
  "trading",
  "trader",
  "analyst",
  "macro-analyst",
  "fundamentals-analyst",
  "technical-analyst",
  "sentiment-analyst",
  "event-analyst",
  "signal-synthesizer",
  "quant-strategist",
  "risk-manager",
  "execution-trader",
  "portfolio-manager",
  "research",
  "researcher",
]);

/** Dev-team roles that get the `dev/` instruction template. */
const DEV_ROLES = new Set([
  "dev",
  "developer",
  "engineer",
  "frontend",
  "backend",
  "fullstack",
  "designer",
  "qa",
  "devops",
  "game-developer",
  "game-designer",
]);

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  const normalized = role.toLowerCase().trim();
  if (normalized === "ceo") return "ceo";
  if (TRADING_ROLES.has(normalized)) return "trading";
  if (DEV_ROLES.has(normalized)) return "dev";
  return "default";
}

import fs from "node:fs/promises";
import { appendAntiEarlyStopInstructions } from "./anti-early-stop-instructions.js";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

const DEFAULT_AGENT_BUNDLE_ENTRY_FILE = "AGENTS.md";

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      // The anti-early-stop block has to be the last thing in the system prompt.
      // AGENTS.md is the entry file for every built-in bundle role, so appending
      // here (rather than editing the asset) keeps it last as the assets grow.
      const body = fileName === DEFAULT_AGENT_BUNDLE_ENTRY_FILE
        ? appendAntiEarlyStopInstructions(content)
        : content;
      return [fileName, body] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "ceo" ? "ceo" : "default";
}

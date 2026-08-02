export const AGENTSKY_HARNESSES = ["claude_code", "codex", "openclaw", "hermes"] as const;

export type AgentskyHarness = (typeof AGENTSKY_HARNESSES)[number];

export const AGENTSKY_HARNESS_LABELS: Record<AgentskyHarness, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

/**
 * AgentSky harness → selectable model ids. First entry is the harness default.
 * AgentSky has no public model-listing API; this mirrors its creation menu.
 */
export const AGENTSKY_MODELS: Record<AgentskyHarness, readonly string[]> = {
  claude_code: ["claude-opus-5", "claude-fable-5", "claude-sonnet-4-6", "kimi-k3"],
  codex: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"],
  openclaw: [
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "gemini-3.5-flash",
    "glm-5.2",
    "kimi-k3",
  ],
  hermes: [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gemini-3.5-flash",
    "glm-5.2",
    "kimi-k3",
  ],
};

export const DEFAULT_AGENTSKY_HARNESS: AgentskyHarness = "claude_code";

export const DEFAULT_AGENTSKY_API_BASE_URL = "https://agentsky.dev";

export function isAgentskyHarness(value: string): value is AgentskyHarness {
  return (AGENTSKY_HARNESSES as readonly string[]).includes(value);
}

export function defaultAgentskyModel(harness: AgentskyHarness): string {
  return AGENTSKY_MODELS[harness][0];
}

export function isAgentskyModelCompatible(harness: AgentskyHarness, model: string): boolean {
  return AGENTSKY_MODELS[harness].includes(model);
}

export function renderAgentskyModelMatrix(): string {
  return AGENTSKY_HARNESSES.map((harness) => {
    const [first, ...rest] = AGENTSKY_MODELS[harness];
    return `  - ${harness}: ${[`${first} (default)`, ...rest].join(", ")}`;
  }).join("\n");
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AI_CONNECTION_CAPABILITIES } from "../../packages/shared/src/ai-connections.js";
import { isAiRoutingCompatible } from "../../packages/shared/src/ai-provider-routing.js";
import type { AiProviderRouting } from "../../packages/shared/src/ai-provider-routing.js";
import type { EnvironmentFixture, MatrixExecution, RunnerProfileFixture, RunnerSuiteFixture, RunnerTaskFixture } from "./types.js";

export const connectionModes = ["subscription", "api-key", "openrouter", "bedrock", "responses", "messages", "chat"] as const;
export type ConnectionMode = typeof connectionModes[number];
export type ConnectionEntry = "agent" | "apps";
export const connectionHarnesses = [
  { id: "claude", adapter: "claude_local", provider: "anthropic", label: "Claude", key: "ANTHROPIC_API_KEY", native: true },
  { id: "codex", adapter: "codex_local", provider: "openai", label: "OpenAI", key: "OPENAI_API_KEY", native: true },
  { id: "grok", adapter: "grok_local", provider: "xai", label: "Grok", key: "XAI_API_KEY", native: true },
  { id: "gemini", adapter: "gemini_local", provider: "google", label: "Google", key: "GEMINI_API_KEY", native: false },
  { id: "opencode", adapter: "opencode_local", provider: "openrouter", label: "OpenRouter", key: "OPENROUTER_API_KEY", native: true },
  { id: "hermes", adapter: "hermes_local", provider: "openrouter", label: "OpenRouter", key: "OPENROUTER_API_KEY", native: false },
] as const;
export type ConnectionHarness = typeof connectionHarnesses[number];

/** Inventory entries remain visible even when no live journey can be selected. */
export const connectionScopeGaps = [
  { adapter: "cursor", status: "unsupported", reason: "No managed connection flow; qualify the harness-specific login separately." },
  { adapter: "kimi_local", status: "unsupported", reason: "No managed connection flow; harness-specific credentials remain outside this suite." },
  { adapter: "pi_local", status: "unsupported", reason: "No managed connection flow or qualified model source." },
  { adapter: "openclaw_gateway", status: "excluded", reason: "Remote gateway owns provider configuration." },
  { adapter: "hermes_gateway", status: "excluded", reason: "Remote gateway owns provider configuration." },
  { adapter: "cursor_cloud", status: "excluded", reason: "Remote integration owns provider configuration." },
  { adapter: "process", status: "excluded", reason: "External process owns provider configuration." },
  { adapter: "http", status: "excluded", reason: "Remote integration owns provider configuration." },
  { adapter: "acpx_local", status: "excluded", reason: "Generic legacy integration; native Claude/Grok ACPX profiles remain covered." },
  { adapter: "claude_managed", status: "excluded", reason: "Managed remote integration owns credentials." },
  { adapter: "aws_agentcore", status: "excluded", reason: "Remote integration owns credentials." },
] as const;

export function routingForMode(mode: ConnectionMode): AiProviderRouting | undefined {
  if (mode === "subscription" || mode === "api-key") return undefined;
  return { kind: mode === "openrouter" || mode === "bedrock" ? mode : "gateway", protocol: mode === "openrouter" ? "responses" : mode, auth: "bearer", models: [], ...(mode === "bedrock" ? { region: "us-east-1" } : {}) };
}

export function supportsConnection(harness: ConnectionHarness, mode: ConnectionMode) {
  const routing = routingForMode(mode);
  if (routing) return isAiRoutingCompatible(routing, harness.adapter);
  // OpenRouter's normal key is represented by its explicit routing case.
  if (harness.provider === "openrouter") return false;
  const methods = AI_CONNECTION_CAPABILITIES[harness.provider].methods;
  return Boolean(methods[mode === "subscription" ? "subscription" : "api_key"]?.adapters.includes(harness.adapter));
}

export function connectionCell(execution: MatrixExecution) {
  const match = /^(agent|apps)-(subscription|api-key|openrouter|bedrock|responses|messages|chat)$/.exec(execution.task.id);
  const harness = connectionHarnesses.find(h => execution.profile.id === `connection-${h.id}-${execution.profile.generation}`);
  if (execution.suite.id !== "provider-connections" || !harness || !match) throw new Error("Not a provider connection execution");
  return { harness, entry: match[1] as ConnectionEntry, mode: match[2] as ConnectionMode };
}

export function buildConnectionSuite(profiles: readonly RunnerProfileFixture[], environments: readonly EnvironmentFixture[]): RunnerSuiteFixture {
  const selectedProfiles = connectionHarnesses.flatMap(h => (["legacy", ...(h.native ? ["native"] : [])] as Array<"legacy" | "native">).map(generation => {
    const existing = profiles.find(p => p.generation === generation && (p.adapterType === h.adapter || (generation === "native" && p.id === (h.id === "claude" || h.id === "grok" ? `runner-acpx-${h.id}` : `runner-${h.id}`))));
    const id = `connection-${h.id}-${generation}`;
    return {
      id, label: `${h.label} ${generation}`, generation, groups: [generation], adapterType: generation === "native" ? "paperclip_runner" : h.adapter,
      provider: h.id, model: existing?.model ?? "configured-in-connection-file",
      modelQualification: existing?.modelQualification ?? { source: "candidate_runner_profile", qualificationId: "operator-configured-model" },
      credential: h.key,
      supportedEnvironments: ["local", "daytona"], expectedRuntimeMode: generation,
      expectedRuntimeMetadata: { adapterType: generation === "native" ? "paperclip_runner" : h.adapter, provider: generation === "native" && ["claude", "grok"].includes(h.id) ? "acpx" : h.id },
      buildAgent: () => ({ name: id, role: "qa", adapterType: generation === "native" ? "paperclip_runner" : h.adapter, adapterConfig: {}, runtimeConfig: {} }),
    } satisfies RunnerProfileFixture;
  }));
  const tasks: RunnerTaskFixture[] = (["agent", "apps"] as const).flatMap(entry => connectionModes.map(mode => ({
    id: `${entry}-${mode}`, label: `${entry === "apps" ? "Apps connector" : "New agent"} · ${mode}`, groups: [], flow: "provider_connection", workMode: "standard",
    expectedRunCount: 3, minimumExpectedRunCount: 2,
    attemptTimeoutMs: { local: 30 * 60_000, daytona: 30 * 60_000 }, turnTimeoutMs: 5 * 60_000,
    expectedTerminalState: { issue: "done", run: "succeeded" },
    buildTitle: nonce => `Connection proof ${nonce}`, buildPrompt: () => "Runtime-generated independent attachment proof.", buildVisibleMarker: nonce => nonce,
    buildMatchers: () => [],
  })));
  const excludedExecutionIds = selectedProfiles.flatMap(profile => environments.flatMap(environment => tasks.flatMap(task => {
    const harness = connectionHarnesses.find(h => profile.id === `connection-${h.id}-${profile.generation}`)!;
    const mode = task.id.replace(/^(agent|apps)-/, "") as ConnectionMode;
    return supportsConnection(harness, mode) ? [] : [`provider-connections.${profile.id}.${environment.id}.${task.id}`];
  })));
  const hash = createHash("sha256");
  for (const file of ["connection-cases.ts", "connection-config.ts", "connection-flow.ts", "connection-evidence.ts", "connection-launch.ts", "connection-target.ts", "user-actions.ts"]) hash.update(file).update(readFileSync(new URL(`./${file}`, import.meta.url)));
  const digest = hash.digest("hex");
  return { id: "provider-connections", label: "Live provider connections", description: "Fresh production UI connections, attended subscription login, independently verified tasks and reuse on a selected deployment.", groups: [], manualOnly: true, profiles: selectedProfiles, environments, tasks, excludedExecutionIds, expectedMatrixSize: selectedProfiles.length * environments.length * tasks.length - excludedExecutionIds.length, definitionMetadata: { version: 1, digest, authentication: "fresh-ui-connection", traces: "disabled", scheduling: "explicit-only" } };
}

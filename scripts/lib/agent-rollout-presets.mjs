/**
 * Managed agents (by name/role) use OpenCode + a free `opencode/*` model by default.
 * Default is Minimax M2.5 (free); override with `PAPERCLIP_OPENCODE_QUOTA_FALLBACK_MODEL`.
 * Verify on the host: `opencode models` (ids vary by OpenCode version).
 * Keep UI copy in `CodexSubscriptionPanel` in sync with DEFAULT_OPENCODE_QUOTA_FALLBACK_MODEL.
 */

import path from "node:path";

/** True when `command` is the Codex CLI (bare name or absolute path, e.g. macOS `.../Codex.app/.../codex`). */
export function commandLooksLikeCodexCli(command) {
  const t = typeof command === "string" ? command.trim() : "";
  if (!t) return false;
  const base = path.basename(t).toLowerCase();
  return base === "codex" || base === "codex.cmd" || base === "codex.exe";
}

/** Default when OpenCode lists a short provider id (e.g. `opencode/...`). Override with PAPERCLIP_OPENCODE_QUOTA_FALLBACK_MODEL or use OpenRouter slug. */
export const DEFAULT_OPENCODE_QUOTA_FALLBACK_MODEL = "opencode/minimax-m2.5-free";

export function resolveOpencodeQuotaFallbackModel() {
  return process.env.PAPERCLIP_OPENCODE_QUOTA_FALLBACK_MODEL?.trim() || DEFAULT_OPENCODE_QUOTA_FALLBACK_MODEL;
}

export function normalizeAgentName(name) {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/** @returns {string | null} */
function managedAgentLabel(agent) {
  const n = normalizeAgentName(agent.name);

  if (n.includes("revisor")) return "revisor";
  if (n.includes("seguranc")) return "security";
  if (n.includes("triagem")) return "triage";
  if (n.includes("coordenador")) return "coordinator";
  if (n.includes("claudio")) return "implementer";
  if (agent.role === "ceo" || n === "ceo" || n.startsWith("ceo ")) return "ceo";

  return null;
}

/**
 * Agents that should run on OpenCode + managed free preset (matched by name/role).
 * Only `codex_local` and `opencode_local` are eligible — avoids retargeting e.g. Claude agents with similar names.
 *
 * @returns {{ label: string, model: string } | null}
 */
export function managedAgentNemotronPreset(agent) {
  if (agent.status === "terminated") return null;
  if (agent.adapterType !== "codex_local" && agent.adapterType !== "opencode_local") return null;

  const label = managedAgentLabel(agent);
  if (!label) return null;

  return { label, model: resolveOpencodeQuotaFallbackModel() };
}

const CODEX_ONLY_ADAPTER_KEYS = new Set([
  "model",
  "modelReasoningEffort",
  "reasoningEffort",
  "dangerouslyBypassApprovalsAndSandbox",
  "dangerouslyBypassSandbox",
  "search",
  "paperclipRuntimeSkills",
  "extraArgs",
]);

export function buildOpenCodeAdapterConfigFromCodex(codexConfig, opencodeModel) {
  const src =
    codexConfig && typeof codexConfig === "object" && !Array.isArray(codexConfig)
      ? codexConfig
      : {};
  const out = { model: opencodeModel };

  for (const [key, value] of Object.entries(src)) {
    if (CODEX_ONLY_ADAPTER_KEYS.has(key)) continue;
    out[key] = value;
  }

  const cmd = typeof out.command === "string" ? out.command.trim() : "";
  if (!cmd || commandLooksLikeCodexCli(cmd)) {
    out.command = "opencode";
  }

  if (typeof out.timeoutSec !== "number") {
    out.timeoutSec = 0;
  }
  if (typeof out.graceSec !== "number") {
    out.graceSec = 20;
  }

  return out;
}

/** Build `adapterConfig` for `opencode_local` + target free model from any prior adapter config. */
export function buildNemotronOpenCodeAdapterConfig(agent, opencodeModel) {
  if (agent.adapterType === "codex_local") {
    return buildOpenCodeAdapterConfigFromCodex(agent.adapterConfig, opencodeModel);
  }

  const src =
    agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
      ? { ...agent.adapterConfig }
      : {};

  for (const key of CODEX_ONLY_ADAPTER_KEYS) {
    delete src[key];
  }

  const out = {
    ...src,
    model: opencodeModel,
  };

  const cmd = typeof out.command === "string" ? out.command.trim() : "";
  if (!cmd || commandLooksLikeCodexCli(cmd)) {
    out.command = "opencode";
  }
  if (typeof out.timeoutSec !== "number") {
    out.timeoutSec = 0;
  }
  if (typeof out.graceSec !== "number") {
    out.graceSec = 20;
  }

  return out;
}

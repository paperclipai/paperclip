import type { AcpRuntimeStatus } from "acpx/runtime";

import { isPlaceholderModelId } from "../model-identity.js";

export type AcpxModelSource = "session" | "requested" | "unknown";

export interface AcpxEffectiveModel {
  /** The model to attribute the run to, or null when it cannot be determined. */
  model: string | null;
  /** Where `model` came from, so downstream cost auditing can tell resolved attribution from an echo of the request. */
  source: AcpxModelSource;
}

interface AcpxSelectOption {
  value?: unknown;
  name?: unknown;
  description?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readClaudeModelFamily(value: string): string | null {
  const match = value.match(/\b(opus|sonnet|haiku|fable|mythos)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function readClaudeModelVersion(value: string): string | null {
  const match = value.match(/\b(?:opus|sonnet|haiku|fable|mythos)\s+(\d+(?:\.\d+)*)\b/i);
  return match?.[1]?.replaceAll(".", "-") ?? null;
}

/**
 * Resolve a Claude ACP picker value to the concrete model described by the
 * server's model config option. Claude's ACP server intentionally exposes
 * semantic values such as `default`, `sonnet`, and `opus[1m]`; their option
 * metadata carries the resolved family/version (for example "Opus 4.8 with 1M
 * context"). Reading that metadata avoids a hard-coded alias table that would
 * silently go stale the next time Claude's default advances.
 */
export function resolveClaudeAcpModelId(
  status: AcpRuntimeStatus | null | undefined,
  selectedModelId: string,
): string | null {
  const details = asRecord(status?.details);
  const configOptions = details?.configOptions;
  if (!Array.isArray(configOptions)) return null;

  const modelOption = configOptions
    .map(asRecord)
    .find((option) => option?.id === "model");
  if (!modelOption || !Array.isArray(modelOption.options)) return null;

  const selected = modelOption.options
    .map(asRecord)
    .find((option): option is Record<string, unknown> => option?.value === selectedModelId);
  if (!selected) return null;

  const option = selected as AcpxSelectOption;
  const text = [option.name, option.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const family = readClaudeModelFamily(text);
  const version = readClaudeModelVersion(text);
  if (!family || !version) return null;

  const contextSuffix = /\b1m\b/i.test(`${selectedModelId} ${text}`) ? "[1m]" : "";
  return `claude-${family}-${version}${contextSuffix}`;
}

/**
 * Read the concrete model id the ACP session reports it is running, or null
 * when the session only offers a placeholder. `AcpRuntimeStatus.models` is
 * sourced from the persisted session record's advertised model state, which the
 * ACP server populates from `session/new` and `set_config_option` responses —
 * so it reflects the model actually in effect rather than the one requested.
 *
 * `claude-agent-acp` advertises `default` as the first entry of its model list
 * and reports it back as `currentModelId` whenever no concrete model was
 * selected; the runtime also normalizes a missing id to the empty string.
 * Neither identifies the model a turn ran on, so neither is returned here.
 */
export function readAcpxSessionModelId(
  status: AcpRuntimeStatus | null | undefined,
  acpxAgent?: string,
): string | null {
  const currentModelId = status?.models?.currentModelId;
  if (typeof currentModelId !== "string" || !currentModelId.trim()) return null;
  const trimmed = currentModelId.trim();
  if (acpxAgent === "claude") {
    const resolved = resolveClaudeAcpModelId(status, trimmed);
    if (resolved) return resolved;
  }
  if (isPlaceholderModelId(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve which model a run should be billed against.
 *
 * The ACP engine used to report `config.model` verbatim, which is the model the
 * run *asked for*, not the one it *got*. Agents that leave `adapterConfig.model`
 * unset — a supported configuration that lets the ACP server pick its own
 * default — therefore reported no model at all, and every cost event they
 * produced was recorded as `unknown`. Reading the session's own current model
 * back recovers attribution for those runs.
 *
 * Preference order:
 *  1. the post-turn session model — what the turn actually ran on;
 *  2. the pre-turn session model — the session's state before the turn, used
 *     when the post-turn read fails (the runtime can be torn down first);
 *  3. the requested model — a correct answer whenever the request was honored,
 *     and the only signal available when the session advertises no model state;
 *  4. null — the run genuinely ran on an unidentified model. The caller records
 *     that as `unknown` rather than guessing.
 */
export function resolveAcpxEffectiveModel(input: {
  postStatus?: AcpRuntimeStatus | null;
  preStatus?: AcpRuntimeStatus | null;
  requestedModel?: string | null;
  acpxAgent?: string;
}): AcpxEffectiveModel {
  const sessionModel =
    readAcpxSessionModelId(input.postStatus, input.acpxAgent) ??
    readAcpxSessionModelId(input.preStatus, input.acpxAgent);
  if (sessionModel) return { model: sessionModel, source: "session" };

  const requested = typeof input.requestedModel === "string" ? input.requestedModel.trim() : "";
  if (requested) return { model: requested, source: "requested" };

  return { model: null, source: "unknown" };
}

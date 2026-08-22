import type { AcpRuntimeStatus } from "acpx/runtime";

import { isPlaceholderModelId } from "../model-identity.js";

export type AcpxModelSource = "session" | "requested" | "unknown";

export interface AcpxEffectiveModel {
  /** The model to attribute the run to, or null when it cannot be determined. */
  model: string | null;
  /** Where `model` came from, so downstream cost auditing can tell resolved attribution from an echo of the request. */
  source: AcpxModelSource;
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
export function readAcpxSessionModelId(status: AcpRuntimeStatus | null | undefined): string | null {
  const currentModelId = status?.models?.currentModelId;
  if (isPlaceholderModelId(currentModelId)) return null;
  return (currentModelId as string).trim();
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
}): AcpxEffectiveModel {
  const sessionModel =
    readAcpxSessionModelId(input.postStatus) ?? readAcpxSessionModelId(input.preStatus);
  if (sessionModel) return { model: sessionModel, source: "session" };

  const requested = typeof input.requestedModel === "string" ? input.requestedModel.trim() : "";
  if (requested) return { model: requested, source: "requested" };

  return { model: null, source: "unknown" };
}

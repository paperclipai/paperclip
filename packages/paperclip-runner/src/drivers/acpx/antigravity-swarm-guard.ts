import { createHash } from "node:crypto";
import type { ProviderFailure } from "../../contracts/provider-failure.generated.js";
import { createProviderFailure } from "../provider-failure.js";
import { ANTIGRAVITY_CLI_DISTRIBUTION } from "./antigravity-cli-pins.js";
import { GENERATED_ANTIGRAVITY_SWARM_PROVIDER_MODE, type GeneratedAntigravitySwarmChannel } from "./generated-sidecar-contract.js";

/**
 * Google Antigravity CLI route (`agy acp`), used only for a turn the signed-in
 * user started with a trusted `/swarm`. The registry server's owned admission
 * patch does not exist here (the CLI is a signed binary with no patch point),
 * so this guard verifies what the connection itself reports instead, and fails
 * closed on any difference:
 *
 * - agent identity and version from `initialize` equal the pinned CLI;
 * - the CLI accepts Paperclip's instructions through `systemPrompt.append`;
 * - the session's working directory is the task workspace, and the only MCP
 *   server is the runner-owned Paperclip bridge;
 * - session mode reads back as `auto` after `session/set_mode`;
 * - model family and thinking level read back as the agent's configured model;
 * - none of those change later in the session;
 * - helpers share the task workspace (`inherit`); `share` and `branch` are refused.
 */
export const ANTIGRAVITY_SWARM_MODE = GENERATED_ANTIGRAVITY_SWARM_PROVIDER_MODE;
export const ANTIGRAVITY_CLI_AGENT_NAME = "Antigravity ACP Server";
export const ANTIGRAVITY_CLI_SESSION_MODE = "auto";
/** Google's stable endpoint; the CLI's default is the daily one. */
export const ANTIGRAVITY_CLI_STABLE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SWARM_MCP_SERVER = "paperclip";

export type AntigravitySwarmErrorCode =
  | "ANTIGRAVITY_SWARM_UNAVAILABLE"
  | "ANTIGRAVITY_SWARM_SIGN_IN_REQUIRED"
  | "ANTIGRAVITY_SWARM_RECEIPT_MISMATCH"
  | "ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE"
  | "ANTIGRAVITY_SWARM_HELPERS_TIMEOUT"
  /** The swarm turn ended without handing in (no helpers ran, or Paperclip blocked an action). */
  | "ANTIGRAVITY_SWARM_NO_RESULT";

const CATEGORY: Record<AntigravitySwarmErrorCode, ProviderFailure["category"]> = {
  // Each of these needs the person to change something; a plain Retry meets the same refusal.
  ANTIGRAVITY_SWARM_UNAVAILABLE: "invalid_request",
  ANTIGRAVITY_SWARM_SIGN_IN_REQUIRED: "authentication",
  ANTIGRAVITY_SWARM_RECEIPT_MISMATCH: "unknown",
  ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE: "unknown",
  ANTIGRAVITY_SWARM_HELPERS_TIMEOUT: "timeout",
  ANTIGRAVITY_SWARM_NO_RESULT: "unknown",
};

/**
 * `message` is written for the person who asked for the swarm. `diagnostic` is
 * operator evidence (for example the models the CLI offered); it travels as the
 * sidecar's rejection message, never in the user's provider failure.
 */
export class AntigravitySwarmError extends Error {
  readonly retryable = false;
  /** Lets the sidecar hand this plain message to the user instead of a generic open failure. */
  readonly providerFailure: ProviderFailure | null;
  readonly diagnostic: string | null;
  constructor(readonly code: AntigravitySwarmErrorCode, message: string,
    options: { category?: ProviderFailure["category"]; diagnostic?: string } = {}) {
    super(message);
    this.name = "AntigravitySwarmError";
    this.diagnostic = options.diagnostic ?? null;
    // No providerCode: the code travels as the sidecar error code, and people never see it.
    this.providerFailure = createProviderFailure({ provider: "antigravity", phase: "startup", message,
      category: options.category ?? CATEGORY[code] });
  }
}

const LEVEL_NAMES: Record<string, string> = {
  minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", extra_high: "Extra high", max: "Max",
};

/** A readable name for a `<family>-<level>` id the CLI did not list (so it has no name of its own). */
export function antigravitySwarmModelName(id: string): string {
  const cut = id.lastIndexOf("-");
  const level = cut > 0 ? LEVEL_NAMES[id.slice(cut + 1)] : undefined;
  const words: string[] = [];
  for (const token of (level ? id.slice(0, cut) : id).split("-").filter(Boolean)) {
    if (/^\d+$/.test(token) && /^\d+(?:\.\d+)*$/.test(words.at(-1) ?? "")) words[words.length - 1] += `.${token}`;
    else words.push(/^[a-z]/.test(token) ? token[0]!.toUpperCase() + token.slice(1) : token);
  }
  const family = words.join(" ");
  return level ? `${family} (${level})` : family;
}

/** The models a `session/new` result offers, as `{ id, name }`. */
function offeredModels(value: Json): Array<{ id: string; name: string }> {
  const available = record(value.models).availableModels;
  return Array.isArray(available) ? available.flatMap(entry => {
    const model = record(entry);
    return typeof model.modelId === "string" && model.modelId
      ? [{ id: model.modelId, name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : antigravitySwarmModelName(model.modelId) }] : [];
  }) : [];
}

/** The CLI's default family, by its own name, as a suggestion. */
function defaultFamilyName(value: Json): string | null {
  const options = record(value).configOptions;
  const model = Array.isArray(options) ? options.map(record).find(option => option.id === "model") : undefined;
  const choices = Array.isArray(model?.options) ? model.options.map(record) : [];
  const current = choices.find(choice => choice.value === model?.currentValue) ?? choices[0];
  return typeof current?.name === "string" && current.name.trim() ? current.name.trim() : null;
}

const MAX_DIAGNOSTIC_MODELS = 40;

const mismatch = (detail: string): never => {
  throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_RECEIPT_MISMATCH",
    `Swarm stopped before it started: ${detail}. Nothing was changed.`);
};

/** What the driver verified in place of the registry server's admission receipt. */
export interface AntigravitySwarmReceipt {
  agentName: string;
  /** The pinned CLI version the CLI itself reported in `initialize`. */
  agentVersion: string;
  sessionId: string;
  workspace: string;
  mode: typeof ANTIGRAVITY_CLI_SESSION_MODE;
  model: string;
  /** The CLI's own name for the confirmed model, for people. */
  modelName: string;
  modelFamily: string;
  thoughtLevel: string | null;
  instructionDigest: string;
  mcpServers: string[];
}

export interface AntigravitySwarmGuardOptions {
  model: string;
  /** The Google channel the CLI was launched on; a refusal on `stable` names the fix. */
  channel?: GeneratedAntigravitySwarmChannel;
  instructions: string;
  workspace: string;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

export function antigravitySwarmInstructionDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** The `model` / `thought_level` / `mode` selections in a config option list. */
export function antigravitySelections(value: unknown): Map<string, string> {
  const selections = new Map<string, string>();
  const options = record(value).configOptions;
  if (!Array.isArray(options)) return selections;
  for (const entry of options) {
    const option = record(entry);
    if (typeof option.id === "string" && typeof option.currentValue === "string"
      && ["model", "thought_level", "mode"].includes(option.id)) selections.set(option.id, option.currentValue);
  }
  return selections;
}

export function createAntigravitySwarmGuard(options: AntigravitySwarmGuardOptions) {
  const model = options.model.trim();
  if (!model || model.length > 512 || /[\u0000-\u001f]/.test(model)) mismatch("the agent has no exact model");
  const instructionDigest = antigravitySwarmInstructionDigest(options.instructions);
  const state = {
    agentName: "", agentVersion: "", sessionId: "", modeBound: false, modelBound: false,
    selections: new Map<string, string>(), commands: null as string[] | null, mcpServers: [] as string[], modelName: "",
  };
  const assertStable = (next: Map<string, string>) => {
    for (const [id, value] of next) {
      const bound = id === "mode" ? state.modeBound : state.modelBound;
      if (bound && state.selections.get(id) !== value) mismatch("the provider changed the confirmed model, thinking level, or permission mode");
      state.selections.set(id, value);
    }
  };
  return {
    instructionDigest,
    /** `initialize` result: exact pinned identity and the instruction channel. */
    initialize(result: unknown): void {
      const value = record(result);
      const info = record(value.agentInfo);
      if (info.name !== ANTIGRAVITY_CLI_AGENT_NAME || info.version !== ANTIGRAVITY_CLI_DISTRIBUTION.version) {
        mismatch("the Antigravity CLI did not report its pinned version");
      }
      const append = record(record(record(record(value.agentCapabilities)._meta).antigravity).systemPrompt).append;
      if (append !== true) mismatch("the Antigravity CLI cannot receive Paperclip's instructions");
      state.agentName = info.name as string;
      state.agentVersion = info.version as string;
    },
    /** The exact `session/new` request this route sends; refuses anything else. */
    sessionRequest(params: Json): void {
      if (params.cwd !== options.workspace) mismatch("the session is not in the task folder");
      const servers = Array.isArray(params.mcpServers) ? params.mcpServers.map(record) : [];
      if (servers.length !== 1 || servers[0]!.name !== ANTIGRAVITY_SWARM_MCP_SERVER || servers[0]!.type !== "http") {
        mismatch("the session must use only Paperclip's own tools");
      }
      const appended = record(record(record(params._meta).antigravity).systemPrompt).append;
      if (typeof appended !== "string" || antigravitySwarmInstructionDigest(appended) !== instructionDigest) {
        mismatch("Paperclip's instructions are missing from the session");
      }
      state.mcpServers = [ANTIGRAVITY_SWARM_MCP_SERVER];
    },
    sessionResult(result: unknown): string {
      if (!state.agentName) mismatch("the provider was not identified");
      if (state.mcpServers.length === 0) mismatch("the session request was not checked");
      const value = record(result);
      if (typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 256) mismatch("the provider did not open a session");
      const modes = record(value.modes).availableModes;
      if (!Array.isArray(modes) || !modes.some(mode => record(mode).id === ANTIGRAVITY_CLI_SESSION_MODE)) {
        throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE",
          "Swarm is not available with this Google connection: helpers can only change files in Antigravity's auto mode, which this sign-in does not offer.");
      }
      const offered = offeredModels(value);
      const selected = offered.find(entry => entry.id === model);
      if (!selected) {
        // The CLI lists each model as `<family>-<level>`, the same spelling as the agent's
        // model, so a missing entry means the CLI does not serve it (seen live: Google's
        // stable endpoint, which this route uses, offers no Gemini 4 Neon).
        const suggestion = defaultFamilyName(value);
        const another = `choose another model for this agent${suggestion ? `, such as ${suggestion},` : ""} and send /swarm again`;
        throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", options.channel === "stable"
          ? `Swarm is not available with ${antigravitySwarmModelName(model)} on Google's stable channel, so nothing was changed: an admin can switch swarms to Google's default channel, or ${another}.`
          : `Swarm is not available with ${antigravitySwarmModelName(model)} yet, so nothing was changed: ${another}.`,
          { category: "model_unavailable",
            diagnostic: `The Antigravity CLI offered ${offered.length} models and not ${model}: ${offered.slice(0, MAX_DIAGNOSTIC_MODELS).map(entry => entry.id).join(", ") || "none"}` });
      }
      state.modelName = selected.name;
      state.sessionId = value.sessionId as string;
      assertStable(antigravitySelections(value));
      return state.sessionId;
    },
    /** Every inbound `session/update`; throws on a change to a confirmed setting. */
    observe(params: unknown): void {
      const value = record(params);
      if (!state.sessionId || value.sessionId !== state.sessionId) return;
      const update = record(value.update);
      if (update.sessionUpdate === "current_mode_update") {
        if (typeof update.currentModeId !== "string") mismatch("the provider reported an invalid permission mode");
        assertStable(new Map([["mode", update.currentModeId as string]]));
      } else if (update.sessionUpdate === "config_option_update") {
        assertStable(antigravitySelections(update));
      } else if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
        state.commands = update.availableCommands.map(command => String(record(command).name));
      }
    },
    /** After `session/set_mode auto`: the read-back must say `auto`. */
    bindMode(): void {
      if (state.selections.get("mode") !== ANTIGRAVITY_CLI_SESSION_MODE) mismatch("the provider did not confirm auto mode");
      state.modeBound = true;
    },
    /** After `session/set_model <concrete>`: family plus thinking level must read back as that model. */
    bindModel(): void {
      const family = state.selections.get("model");
      const level = state.selections.get("thought_level");
      if (!family || (family !== model && `${family}-${level}` !== model)) mismatch(`the provider did not confirm the model ${model}`);
      state.modelBound = true;
    },
    /** `/swarm` must be one of the pinned CLI's own commands for this session. */
    assertSwarmCommand(): void {
      if (state.commands !== null && !state.commands.includes("swarm")) {
        throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", "Swarm is not offered by this Antigravity CLI session.");
      }
    },
    receipt(): AntigravitySwarmReceipt {
      if (!state.sessionId || !state.modeBound || !state.modelBound) mismatch("the session settings were not confirmed");
      const family = state.selections.get("model")!;
      return {
        agentName: state.agentName, agentVersion: state.agentVersion, sessionId: state.sessionId,
        workspace: options.workspace, mode: ANTIGRAVITY_CLI_SESSION_MODE, model, modelName: state.modelName, modelFamily: family,
        thoughtLevel: family === model ? null : state.selections.get("thought_level") ?? null,
        instructionDigest, mcpServers: [...state.mcpServers],
      };
    },
  };
}

export type AntigravitySwarmGuard = ReturnType<typeof createAntigravitySwarmGuard>;

/** A helper started with its own copy of the workspace would write outside the task folder. */
export function antigravitySwarmWorkspaceEscape(update: unknown): string | null {
  const value = record(update);
  if ((value.sessionUpdate !== "tool_call" && value.sessionUpdate !== "tool_call_update") || value.name !== "swarm") return null;
  const args = { ...record(value.rawInput), ...record(value.args) };
  if (args.action !== "add" || args.workspace === undefined || args.workspace === "inherit") return null;
  return typeof args.name === "string" ? args.name : "a helper";
}

export interface AntigravityRefusal {
  kind: "quota_exhausted" | "rate_limit" | "authentication";
  httpStatus?: number;
  status?: string;
  message: string;
}

/**
 * The CLI reports some provider refusals as assistant text and then ends the
 * turn normally (seen live with 402 credits and 429 quota). These are failures.
 */
export function classifyAntigravityRefusalText(text: string): AntigravityRefusal | null {
  const sample = text.slice(0, 4_000);
  if (/prepayment credits are depleted|\bError 402\b|\bcode 402\b/i.test(sample)) {
    return { kind: "quota_exhausted", httpStatus: 402, status: "RESOURCE_EXHAUSTED",
      message: "Google refused the swarm: this account has no credits left." };
  }
  if (/⚠\s*RESOURCE_EXHAUSTED|\bcode 429\b|\bError 429\b/i.test(sample)) {
    return { kind: "rate_limit", httpStatus: 429, status: "RESOURCE_EXHAUSTED",
      message: "Google refused the swarm: this account is out of quota for now. Try again later." };
  }
  if (/⚠.*Authentication required/i.test(sample)) {
    return { kind: "authentication", message: "The Antigravity CLI on this computer is not signed in to Google." };
  }
  return null;
}

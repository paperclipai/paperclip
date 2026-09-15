import { asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";

// Fallback variant Paperclip passes when the agent config does not set one.
//
// Background (ALAA-3794): opencode 1.17.x sends `thinking.type.enabled` for
// its built-in thinking variants (low/high/max/...) even on models whose
// upstream now requires `thinking.type.adaptive` + `output_config.effort`
// (e.g. opencode/claude-opus-5). The provider rejects those requests with a
// 400 and the heartbeat run dies before executing. Probes showed opencode
// silently ignores an unknown variant name and falls back to default request
// options, so passing this name is a no-op on models without a matching
// custom variant definition (see runtime-config.ts, which defines it only
// for the verified models below).
export const PAPERCLIP_ADAPTIVE_VARIANT = "paperclip_adaptive";

// Model IDs (without provider prefix) verified to accept
// `thinking: { type: "adaptive" }` on the opencode provider path. Extend only
// after probing `--variant paperclip_adaptive` against the candidate model:
// `echo <prompt> | opencode run --format json --model opencode/<id>
// --variant paperclip_adaptive` must exit 0 with a runtime config that
// defines the custom variant (see runtime-config.ts).
const ADAPTIVE_THINKING_MODEL_IDS = new Set([
  // ALAA-3794 Error A: 400 "thinking.type.enabled is not supported".
  "claude-opus-5",
  // ALAA-3794: same failure observed on this model; adaptive verified OK and
  // the built-in max variant also still works, so pinning adaptive is safe.
  "muse-spark-1.3-contributor-free",
]);

export function isAdaptiveThinkingModel(model: string | null): boolean {
  if (!model) return false;
  const id = model.trim();
  if (!id) return false;
  const shortId = id.includes("/") ? id.slice(id.indexOf("/") + 1).trim() : id;
  return ADAPTIVE_THINKING_MODEL_IDS.has(shortId);
}

export function adaptiveThinkingVariantDefinitions(): Record<string, Record<string, unknown>> {
  const variants = { [PAPERCLIP_ADAPTIVE_VARIANT]: { thinking: { type: "adaptive" } } };
  const definitions: Record<string, Record<string, unknown>> = {};
  for (const modelId of ADAPTIVE_THINKING_MODEL_IDS) {
    definitions[modelId] = variants;
  }
  return definitions;
}

export function buildOpenCodeRunArgs(input: {
  model?: unknown;
  variant?: unknown;
  extraArgs?: unknown;
  resumeSessionId?: string | null;
  printLogs?: unknown;
}): string[] {
  const model = asString(input.model, "").trim();
  const variant = asString(input.variant, "").trim();
  // Callers pre-resolve the additional CLI args (config.extraArgs, falling
  // back to legacy config.args).
  const extraArgs = asStringArray(input.extraArgs);
  const args = ["run", "--format", "json"];
  if (input.printLogs === true || input.printLogs === "true" || input.printLogs === 1) args.push("--print-logs");
  if (input.resumeSessionId) args.push("--session", input.resumeSessionId);
  if (model) args.push("--model", model);
  args.push("--variant", variant || PAPERCLIP_ADAPTIVE_VARIANT);
  if (extraArgs.length > 0) args.push(...extraArgs);
  return args;
}

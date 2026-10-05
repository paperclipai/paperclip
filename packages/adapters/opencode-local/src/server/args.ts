import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import type { OpenCodeVersionLine } from "./version.js";

export interface BuildRunArgsSpec {
  line: OpenCodeVersionLine;
  model: string;
  variant: string;
  resumeSessionId?: string | null;
  printLogs: boolean;
  autoApprove: boolean;
  extraArgs?: string[];
}

// why: `--auto` auto-approves v2 permission requests in non-interactive mode.
// Emitting it is only safe while BOTH opt-outs are unset: `autoApprove: false`
// turns auto-approval off explicitly, and `dangerouslySkipPermissions: false`
// means the run deliberately keeps OpenCode's own permission prompts — `--auto`
// there would silently approve what the operator asked to gate (security).
// Either explicit opt-out suppresses `--auto`.
export function resolveRunAutoApprove(config: Record<string, unknown>): boolean {
  return (
    asBoolean(config.autoApprove, true) &&
    asBoolean(config.dangerouslySkipPermissions, true)
  );
}

// v2 folds the v1 `--variant` flag into the model string as
// `provider/model#variant`; the v2 CLI rejects `--variant` outright, so the
// variant can only travel inside `--model`. A model that already carries a
// `#suffix` is treated as fully qualified (never double-append), and a variant
// without a model base cannot be expressed on v2 at all, so no flag is emitted.
function resolveV2ModelValue(model: string, variant: string): string | null {
  const trimmedModel = model.trim();
  const trimmedVariant = variant.trim();
  if (!trimmedModel) return null;
  if (!trimmedVariant || trimmedModel.includes("#")) return trimmedModel;
  return `${trimmedModel}#${trimmedVariant}`;
}

// Builds the `opencode` argv for a run, version-aware:
//
// - v1 (and `unknown`, which must stay legacy-safe): exactly the historical
//   argv — `run --format json` plus the v1-only `--print-logs`, `--session`,
//   `--model`, `--variant` flags.
// - v2: `--print-logs` is a global flag that must precede `run`; `--standalone`
//   keeps the run non-interactive; `--auto` is required because v2 otherwise
//   auto-REJECTS permission requests in non-interactive mode (emitted per
//   resolveRunAutoApprove, which suppresses it when `autoApprove` or
//   `dangerouslySkipPermissions` is explicitly false); the variant rides
//   inside `--model` as `provider/model#variant`.
//
// `extraArgs` are appended last on both lines so operator-supplied passthrough
// keeps its trailing position.
export function buildRunArgs(spec: BuildRunArgsSpec): string[] {
  const { line, model, variant, resumeSessionId, printLogs, autoApprove } = spec;
  const extraArgs = spec.extraArgs ?? [];

  if (line === "v2") {
    const args = ["run", "--format", "json", "--standalone"];
    if (printLogs) args.unshift("--print-logs");
    if (resumeSessionId) args.push("--session", resumeSessionId);
    const v2Model = resolveV2ModelValue(model, variant);
    if (v2Model) args.push("--model", v2Model);
    if (autoApprove) args.push("--auto");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  }

  const args = ["run", "--format", "json"];
  if (printLogs) args.push("--print-logs");
  if (resumeSessionId) args.push("--session", resumeSessionId);
  if (model) args.push("--model", model);
  if (variant) args.push("--variant", variant);
  if (extraArgs.length > 0) args.push(...extraArgs);
  return args;
}

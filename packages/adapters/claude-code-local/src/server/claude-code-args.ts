import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";

export type BuildClaudeCodeExecArgsResult = {
  args: string[];
  model: string;
  effort: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

export function buildClaudeCodeExecArgs(
  config: unknown,
  options: { resumeSessionId?: string | null } = {},
): BuildClaudeCodeExecArgsResult {
  const record = asRecord(config);
  const model = asString(record.model, "").trim();
  const effort = asString(record.effort, "").trim();
  const extraArgs = readExtraArgs(record);

  const args = ["--print", "--verbose", "--output-format=stream-json"];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  return {
    args,
    model,
    effort,
  };
}

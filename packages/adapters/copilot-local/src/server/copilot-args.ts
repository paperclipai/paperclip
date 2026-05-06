import { asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_COPILOT_LOCAL_ALLOW_TOOLS,
  DEFAULT_COPILOT_LOCAL_MODEL,
} from "../index.js";

export type BuildCopilotArgsResult = {
  args: string[];
  model: string;
  allowTools: string[];
  allowUrls: string[];
  hasBroadAllowAll: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readExtraArgs(config: Record<string, unknown>): string[] {
  const fromExtraArgs = asStringArray(config.extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(config.args);
}

function readAllowList(value: unknown, fallback: readonly string[] = []): string[] {
  const parsed = asStringArray(value).map((item) => item.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function containsBroadAllowAll(args: string[]): boolean {
  return args.some((arg) =>
    arg === "--allow-all" ||
    arg === "--yolo" ||
    arg === "--allow-all-tools" ||
    arg === "--allow-all-paths" ||
    arg === "--allow-all-urls",
  );
}

export function buildCopilotArgs(config: unknown, prompt: string): BuildCopilotArgsResult {
  const record = asRecord(config);
  const model = asString(record.model, DEFAULT_COPILOT_LOCAL_MODEL).trim();
  const allowTools = readAllowList(record.allowTools, DEFAULT_COPILOT_LOCAL_ALLOW_TOOLS);
  const allowUrls = readAllowList(record.allowUrls);
  const extraArgs = readExtraArgs(record);

  const args = [
    "-p",
    prompt,
    "--output-format=json",
    "--no-ask-user",
  ];
  if (model) args.push("--model", model);
  if (allowTools.length > 0) args.push(`--allow-tool=${allowTools.join(",")}`);
  if (allowUrls.length > 0) args.push(`--allow-url=${allowUrls.join(",")}`);
  if (extraArgs.length > 0) args.push(...extraArgs);

  return {
    args,
    model,
    allowTools,
    allowUrls,
    hasBroadAllowAll: containsBroadAllowAll(args),
  };
}

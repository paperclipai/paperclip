import { createHash } from "node:crypto";

export const NATIVE_RUNTIME_ASSET_SCHEMA = "paperclip.runtime-asset.v1" as const;
export const PAPERCLIP_EXECUTION_PROMPT_REVISION = "paperclip-execution.v1" as const;
export const PAPERCLIP_EXECUTION_PROMPT = "You are running as a Paperclip agent. Complete the assigned task in the provided execution environment. Follow the attached agent instructions and use assigned skills and tools when relevant. Use Paperclip tools for coordination. Finish exactly once with `paperclip_finish` or `paperclip_block`." as const;

export interface NativeRuntimeAssetReference {
  schema: typeof NATIVE_RUNTIME_ASSET_SCHEMA;
  digest: string;
  manifestDigest: string;
  rootPath: string;
  fileCount: number;
  totalBytes: number;
}

export interface NativeRuntimeContextSnapshot {
  prompt: { revision: typeof PAPERCLIP_EXECUTION_PROMPT_REVISION; text: typeof PAPERCLIP_EXECUTION_PROMPT; digest: string };
  instructions: { entryPath: string; bundle: NativeRuntimeAssetReference };
  skills: Array<{ key: string; runtimeName: string; versionId: string | null; bundle: NativeRuntimeAssetReference }>;
  mcp: { assignmentSetId: string; digest: string; bindingId: string | null };
  aggregateDigest: string;
}

export class NativeRuntimeContextError extends Error {
  readonly code = "native_runtime_context_invalid" as const;
  constructor(message: string) { super(message); this.name = "NativeRuntimeContextError"; }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeRuntimeContextError(`${path} must be an object`);
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[], path: string) => {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new NativeRuntimeContextError(`${path} contains unknown field ${unknown}`);
};
const text = (value: unknown, path: string) => {
  if (typeof value !== "string" || !value.trim()) throw new NativeRuntimeContextError(`${path} must be a non-empty string`);
  return value;
};
const digest = (value: unknown, path: string) => {
  const result = text(value, path);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new NativeRuntimeContextError(`${path} must be a sha256 digest`);
  return result;
};
const integer = (value: unknown, path: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new NativeRuntimeContextError(`${path} must be a non-negative integer`);
  return Number(value);
};
const safeRelativePath = (value: unknown, path: string) => {
  const result = text(value, path).replaceAll("\\", "/");
  if (result.startsWith("/") || result.includes("\0") || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new NativeRuntimeContextError(`${path} must stay within its bundle root`);
  }
  return result;
};

function parseAsset(value: unknown, path: string): NativeRuntimeAssetReference {
  const asset = object(value, path);
  exact(asset, ["schema", "digest", "manifestDigest", "rootPath", "fileCount", "totalBytes"], path);
  if (asset.schema !== NATIVE_RUNTIME_ASSET_SCHEMA) throw new NativeRuntimeContextError(`${path}.schema is unsupported`);
  return {
    schema: NATIVE_RUNTIME_ASSET_SCHEMA,
    digest: digest(asset.digest, `${path}.digest`),
    manifestDigest: digest(asset.manifestDigest, `${path}.manifestDigest`),
    rootPath: text(asset.rootPath, `${path}.rootPath`),
    fileCount: integer(asset.fileCount, `${path}.fileCount`),
    totalBytes: integer(asset.totalBytes, `${path}.totalBytes`),
  };
}

function aggregatePayload(value: Omit<NativeRuntimeContextSnapshot, "aggregateDigest">) {
  return {
    prompt: value.prompt,
    instructions: { entryPath: value.instructions.entryPath, bundleDigest: value.instructions.bundle.digest },
    skills: [...value.skills].sort((a, b) => a.key.localeCompare(b.key)).map((skill) => ({
      key: skill.key, runtimeName: skill.runtimeName, versionId: skill.versionId, bundleDigest: skill.bundle.digest,
    })),
    // The binding is deliberately run-scoped. Compatibility is determined by the
    // assigned access set so a fresh capability can be rebound without forcing a
    // provider-session rotation when policy has not changed.
    mcp: { assignmentSetId: value.mcp.assignmentSetId, digest: value.mcp.digest },
  };
}

export function canonicalNativeRuntimeContextDigest(value: Omit<NativeRuntimeContextSnapshot, "aggregateDigest">): string {
  return sha256(JSON.stringify(aggregatePayload(value)));
}

export function nativeRuntimePromptDigest(): string { return sha256(PAPERCLIP_EXECUTION_PROMPT); }

export function parseNativeRuntimeContext(value: unknown): NativeRuntimeContextSnapshot {
  const context = object(value, "input.runtimeContext");
  exact(context, ["prompt", "instructions", "skills", "mcp", "aggregateDigest"], "input.runtimeContext");
  const prompt = object(context.prompt, "input.runtimeContext.prompt");
  exact(prompt, ["revision", "text", "digest"], "input.runtimeContext.prompt");
  if (prompt.revision !== PAPERCLIP_EXECUTION_PROMPT_REVISION || prompt.text !== PAPERCLIP_EXECUTION_PROMPT) {
    throw new NativeRuntimeContextError("input.runtimeContext.prompt must match the fixed Paperclip prompt revision");
  }
  if (digest(prompt.digest, "input.runtimeContext.prompt.digest") !== nativeRuntimePromptDigest()) {
    throw new NativeRuntimeContextError("input.runtimeContext.prompt.digest does not match prompt text");
  }
  const instructions = object(context.instructions, "input.runtimeContext.instructions");
  exact(instructions, ["entryPath", "bundle"], "input.runtimeContext.instructions");
  if (!Array.isArray(context.skills)) throw new NativeRuntimeContextError("input.runtimeContext.skills must be an array");
  const skills = context.skills.map((value, index) => {
    const skill = object(value, `input.runtimeContext.skills[${index}]`);
    exact(skill, ["key", "runtimeName", "versionId", "bundle"], `input.runtimeContext.skills[${index}]`);
    return {
      key: text(skill.key, `input.runtimeContext.skills[${index}].key`),
      runtimeName: safeRelativePath(skill.runtimeName, `input.runtimeContext.skills[${index}].runtimeName`),
      versionId: skill.versionId === null ? null : text(skill.versionId, `input.runtimeContext.skills[${index}].versionId`),
      bundle: parseAsset(skill.bundle, `input.runtimeContext.skills[${index}].bundle`),
    };
  });
  if (new Set(skills.flatMap((skill) => [skill.key, `runtime:${skill.runtimeName}`])).size !== skills.length * 2) {
    throw new NativeRuntimeContextError("input.runtimeContext.skills contains duplicate identities");
  }
  const mcp = object(context.mcp, "input.runtimeContext.mcp");
  exact(mcp, ["assignmentSetId", "digest", "bindingId"], "input.runtimeContext.mcp");
  const parsed = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: safeRelativePath(instructions.entryPath, "input.runtimeContext.instructions.entryPath"), bundle: parseAsset(instructions.bundle, "input.runtimeContext.instructions.bundle") },
    skills,
    mcp: {
      assignmentSetId: text(mcp.assignmentSetId, "input.runtimeContext.mcp.assignmentSetId"),
      digest: digest(mcp.digest, "input.runtimeContext.mcp.digest"),
      bindingId: mcp.bindingId === null ? null : text(mcp.bindingId, "input.runtimeContext.mcp.bindingId"),
    },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  const aggregateDigest = digest(context.aggregateDigest, "input.runtimeContext.aggregateDigest");
  if (aggregateDigest !== canonicalNativeRuntimeContextDigest(parsed)) {
    throw new NativeRuntimeContextError("input.runtimeContext.aggregateDigest does not match the canonical context");
  }
  return { ...parsed, aggregateDigest };
}

export function composeNativeSystemInstructions(context: NativeRuntimeContextSnapshot, entryContent: string): string {
  return [
    context.prompt.text,
    entryContent.trim(),
    `Read-only instruction sibling root: ${context.instructions.bundle.rootPath}`,
  ].filter(Boolean).join("\n\n");
}

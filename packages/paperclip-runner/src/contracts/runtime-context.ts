import { createHash } from "node:crypto";
import {
  PAPERCLIP_AGENT_DIRECTORY_PROMPT,
  PAPERCLIP_EDITABLE_INSTRUCTIONS_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_INSTRUCTION_SIBLING_ROOT_PROMPT,
} from "./runtime-context-prompts.js";
import { GENERATED_RUNTIME_CONTEXT_FIELDS } from "./generated-runtime-context-contract.js";

export { PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION } from "./runtime-context-prompts.js";

export const NATIVE_RUNTIME_ASSET_SCHEMA = "paperclip.runtime-asset.v1" as const;

export interface NativeRuntimeAssetReference {
  schema: typeof NATIVE_RUNTIME_ASSET_SCHEMA;
  digest: string;
  manifestDigest: string;
  rootPath: string;
  fileCount: number;
  totalBytes: number;
}

export interface NativeRuntimeContextSnapshot {
  prompt: { revision: string; text: string; digest: string };
  instructions: {
    entryPath: string;
    bundle: NativeRuntimeAssetReference;
    /** Server-registered writable copy; excluded from the pinned prompt digest. */
    workingCopy?: { rootPath: string; entryPath: string; kind?: "agent_files" };
  };
  skills: Array<{ key: string; runtimeName: string; versionId: string | null; bundle: NativeRuntimeAssetReference }>;
  mcp: { assignmentSetId: string; digest: string; bindingId: string | null };
  connectionInstructions?: { text: string; digest: string };
  aggregateDigest: string;
}

/** Authenticated current-run grants; immutable session policy is verified separately. */
export interface NativeRunRuntimeGrant {
  runtimeContext: NativeRuntimeContextSnapshot | null;
  instructions: string;
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
const exact = (value: Record<string, unknown>, keys: readonly string[], path: string) => {
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
  exact(asset, GENERATED_RUNTIME_CONTEXT_FIELDS.asset, path);
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
    ...(value.connectionInstructions ? { connectionInstructions: value.connectionInstructions } : {}),
  };
}

export function canonicalNativeRuntimeContextDigest(value: Omit<NativeRuntimeContextSnapshot, "aggregateDigest">): string {
  return sha256(JSON.stringify(aggregatePayload(value)));
}

export function nativeRuntimePromptDigest(): string { return sha256(PAPERCLIP_EXECUTION_PROMPT); }

export function parseNativeRuntimeContext(value: unknown): NativeRuntimeContextSnapshot {
  const context = object(value, "input.runtimeContext");
  exact(context, GENERATED_RUNTIME_CONTEXT_FIELDS.runtimeContext, "input.runtimeContext");
  const prompt = object(context.prompt, "input.runtimeContext.prompt");
  exact(prompt, GENERATED_RUNTIME_CONTEXT_FIELDS.prompt, "input.runtimeContext.prompt");
  // New runs use the current constants. Recovery uses the immutable saved
  // snapshot; its revision is metadata, not a lookup in this release's source.
  const promptRevision = text(prompt.revision, "input.runtimeContext.prompt.revision");
  const promptText = text(prompt.text, "input.runtimeContext.prompt.text");
  const promptDigest = digest(prompt.digest, "input.runtimeContext.prompt.digest");
  if (sha256(promptText) !== promptDigest) {
    throw new NativeRuntimeContextError("input.runtimeContext.prompt.digest does not match prompt text");
  }
  const instructions = object(context.instructions, "input.runtimeContext.instructions");
  exact(instructions, GENERATED_RUNTIME_CONTEXT_FIELDS.instructions, "input.runtimeContext.instructions");
  const workingCopy = instructions.workingCopy === undefined ? undefined : object(instructions.workingCopy, "input.runtimeContext.instructions.workingCopy");
  if (workingCopy) exact(workingCopy, GENERATED_RUNTIME_CONTEXT_FIELDS.workingCopy, "input.runtimeContext.instructions.workingCopy");
  if (workingCopy?.kind !== undefined && workingCopy.kind !== "agent_files") throw new NativeRuntimeContextError("Unknown agent file contract");
  if (!Array.isArray(context.skills)) throw new NativeRuntimeContextError("input.runtimeContext.skills must be an array");
  const skills = context.skills.map((value, index) => {
    const skill = object(value, `input.runtimeContext.skills[${index}]`);
    exact(skill, GENERATED_RUNTIME_CONTEXT_FIELDS.skill, `input.runtimeContext.skills[${index}]`);
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
  exact(mcp, GENERATED_RUNTIME_CONTEXT_FIELDS.mcp, "input.runtimeContext.mcp");
  let connectionInstructions: NativeRuntimeContextSnapshot["connectionInstructions"];
  if (context.connectionInstructions !== undefined) {
    const block = object(context.connectionInstructions, "input.runtimeContext.connectionInstructions");
    exact(block, GENERATED_RUNTIME_CONTEXT_FIELDS.connectionInstructions, "input.runtimeContext.connectionInstructions");
    const content = text(block.text, "input.runtimeContext.connectionInstructions.text");
    const contentDigest = digest(block.digest, "input.runtimeContext.connectionInstructions.digest");
    if (sha256(content) !== contentDigest) throw new NativeRuntimeContextError("Connection instruction digest does not match text");
    connectionInstructions = { text: content, digest: contentDigest };
  }
  const parsed = {
    prompt: { revision: promptRevision, text: promptText, digest: promptDigest },
    instructions: {
      entryPath: safeRelativePath(instructions.entryPath, "input.runtimeContext.instructions.entryPath"),
      bundle: parseAsset(instructions.bundle, "input.runtimeContext.instructions.bundle"),
      ...(workingCopy ? { workingCopy: {
        ...(workingCopy.kind === "agent_files" ? { kind: "agent_files" as const } : {}),
        rootPath: text(workingCopy.rootPath, "input.runtimeContext.instructions.workingCopy.rootPath"),
        entryPath: safeRelativePath(workingCopy.entryPath, "input.runtimeContext.instructions.workingCopy.entryPath"),
      } } : {}),
    },
    skills,
    mcp: {
      assignmentSetId: text(mcp.assignmentSetId, "input.runtimeContext.mcp.assignmentSetId"),
      digest: digest(mcp.digest, "input.runtimeContext.mcp.digest"),
      bindingId: mcp.bindingId === null ? null : text(mcp.bindingId, "input.runtimeContext.mcp.bindingId"),
    },
    ...(connectionInstructions ? { connectionInstructions } : {}),
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  const aggregateDigest = digest(context.aggregateDigest, "input.runtimeContext.aggregateDigest");
  if (aggregateDigest !== canonicalNativeRuntimeContextDigest(parsed)) {
    throw new NativeRuntimeContextError("input.runtimeContext.aggregateDigest does not match the canonical context");
  }
  return { ...parsed, aggregateDigest };
}

function renderInstructionPaths(prompt: string, paths: { rootPath: string; entryPath: string }): string {
  return prompt.replace(/\{(rootPath|entryPath)\}/g, (_placeholder, key: "rootPath" | "entryPath") => paths[key]);
}

export function composeNativeSystemInstructions(context: NativeRuntimeContextSnapshot, entryContent: string): string {
  return [
    context.prompt.text,
    entryContent.trim(),
    context.connectionInstructions?.text,
    context.instructions.workingCopy?.kind === "agent_files"
      ? renderInstructionPaths(PAPERCLIP_AGENT_DIRECTORY_PROMPT, context.instructions.workingCopy)
      : context.instructions.workingCopy
      ? renderInstructionPaths(PAPERCLIP_EDITABLE_INSTRUCTIONS_PROMPT, context.instructions.workingCopy)
      : null,
    // Keep this canonical suffix intact for provider-specific asset remapping.
    PAPERCLIP_INSTRUCTION_SIBLING_ROOT_PROMPT + context.instructions.bundle.rootPath,
  ].filter(Boolean).join("\n\n");
}

export function retargetNativeSystemInstructions(
  instructions: string,
  prior: NativeRuntimeContextSnapshot,
  current: NativeRuntimeContextSnapshot | null,
): string {
  const priorPrefix = prior.prompt.text;
  const priorSuffix = composeNativeSystemInstructions(prior, "").slice(priorPrefix.length);
  // Legacy callers can supply opaque system instructions. Only the composer's
  // exact framing identifies a trusted asset block; never rewrite their text.
  if (!instructions.startsWith(priorPrefix) || !instructions.endsWith(priorSuffix)) {
    return instructions;
  }
  const custom = instructions.slice(priorPrefix.length, -priorSuffix.length);
  if (custom && !custom.startsWith("\n\n")) return instructions;
  // Keep custom entry bytes intact, including historical path examples or an
  // identical paragraph quoted inside the entry. Only replace the final block.
  return (current?.prompt.text ?? priorPrefix) + custom + (current
    ? composeNativeSystemInstructions(current, "").slice(current.prompt.text.length)
    : "");
}

/** Explicit per-turn selection; availability alone never invokes a skill. */
export interface NativeSkillInput {
  type: "skill";
  name: string;
  path: string;
}


/** Select only explicit task references from assigned names, never comments. */
export function explicitTaskSkillNames(description: string | null, assignedNames: readonly string[]): string[] {
  if (!description) return [];
  const names = new Set(Array.from(
    description.matchAll(/(?:^|[\s(`])[$/]([a-zA-Z0-9_-]+)(?=$|[\s)`,.;:!?])/g),
    (match) => match[1],
  ));
  return [...new Set(assignedNames)].filter((name) => names.has(name));
}

import { createHash } from "node:crypto";

export const NATIVE_RUNTIME_ASSET_SCHEMA = "paperclip.runtime-asset.v1" as const;
export const PAPERCLIP_EXECUTION_PROMPT_REVISION = "paperclip-execution.v6" as const;
export const PAPERCLIP_EXECUTION_PROMPT = "You are running as a Paperclip agent. Complete the assigned task in the provided execution environment. Follow the attached agent instructions and use assigned skills and tools when relevant. Use Paperclip tools for coordination. To hire or reuse a persistent teammate, use list_agents, then search_api for agent-hires and call_api if a hire is needed. Provider helper threads do not create Paperclip agents. When the user assigns work or a revision to a teammate, use create_task with that agent's ID; review their result rather than doing their assigned work yourself. When remaining work depends on a child task, use set_dependencies to add its ID while preserving existing blocker IDs. Complete independent work, then call paperclip_block with the child agent as owner and child completion as the unblock action. End the turn so the child can use the workspace. Do not sleep or poll for child results while holding the workspace. Paperclip resumes the parent when the dependency completes. When the user asks to connect a service, call connections_search before any service tool, even when that tool is already installed. Follow the returned instruction and wait for any required user choice before executing. For other tasks needing a service, use installed tools if available; otherwise use connections_search and follow its instruction. The request appears as a card in the task. Finish independent work before yielding for access; do not poll or request the same connection repeatedly. Paperclip will continue automatically with updated tools after resolution. After a decline, pursue alternatives unless the user explicitly asks to retry. For a deferred check you own, call set_task_monitor with a future nextCheckAt and notes. Confirm the persisted schedule on the current task, then call paperclip_finish with reportedWorkDisposition yielded and continuation.kind monitor. End the turn; the one-shot monitor wakes you with issue_monitor_due. Re-arm explicitly only if another check is needed. Do not claim a monitor exists without its receipt. Finish exactly once with `paperclip_finish` or `paperclip_block`." as const;

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
    ...(value.connectionInstructions ? { connectionInstructions: value.connectionInstructions } : {}),
  };
}

export function canonicalNativeRuntimeContextDigest(value: Omit<NativeRuntimeContextSnapshot, "aggregateDigest">): string {
  return sha256(JSON.stringify(aggregatePayload(value)));
}

export function nativeRuntimePromptDigest(): string { return sha256(PAPERCLIP_EXECUTION_PROMPT); }

export function parseNativeRuntimeContext(value: unknown): NativeRuntimeContextSnapshot {
  const context = object(value, "input.runtimeContext");
  exact(context, ["prompt", "instructions", "skills", "mcp", "connectionInstructions", "aggregateDigest"], "input.runtimeContext");
  const prompt = object(context.prompt, "input.runtimeContext.prompt");
  exact(prompt, ["revision", "text", "digest"], "input.runtimeContext.prompt");
  // New runs use the current constants. Recovery uses the immutable saved
  // snapshot; its revision is metadata, not a lookup in this release's source.
  const promptRevision = text(prompt.revision, "input.runtimeContext.prompt.revision");
  const promptText = text(prompt.text, "input.runtimeContext.prompt.text");
  const promptDigest = digest(prompt.digest, "input.runtimeContext.prompt.digest");
  if (sha256(promptText) !== promptDigest) {
    throw new NativeRuntimeContextError("input.runtimeContext.prompt.digest does not match prompt text");
  }
  const instructions = object(context.instructions, "input.runtimeContext.instructions");
  exact(instructions, ["entryPath", "bundle", "workingCopy"], "input.runtimeContext.instructions");
  const workingCopy = instructions.workingCopy === undefined ? undefined : object(instructions.workingCopy, "input.runtimeContext.instructions.workingCopy");
  if (workingCopy) exact(workingCopy, ["rootPath", "entryPath", "kind"], "input.runtimeContext.instructions.workingCopy");
  if (workingCopy?.kind !== undefined && workingCopy.kind !== "agent_files") throw new NativeRuntimeContextError("Unknown agent file contract");
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
  let connectionInstructions: NativeRuntimeContextSnapshot["connectionInstructions"];
  if (context.connectionInstructions !== undefined) {
    const block = object(context.connectionInstructions, "input.runtimeContext.connectionInstructions");
    exact(block, ["text", "digest"], "input.runtimeContext.connectionInstructions");
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

export function composeNativeSystemInstructions(context: NativeRuntimeContextSnapshot, entryContent: string): string {
  return [
    context.prompt.text,
    entryContent.trim(),
    context.connectionInstructions?.text,
    context.instructions.workingCopy?.kind === "agent_files"
      ? `Your persistent agent directory (AGENT_HOME) is ${context.instructions.workingCopy.rootPath}. This is the current turn's copy; its absolute path may change between turns. In shell commands, use the current $AGENT_HOME environment variable instead of an absolute agent-directory path from an earlier turn. Your instruction entry is ${context.instructions.workingCopy.entryPath}, relative to that directory. All supported files and subfolders there are restored across tasks and sessions, and collected after this provider stops. Write task deliverables in the task working directory. Only changed or deleted files synchronize; the last sync wins for the same file. Temporary copies are cleaned up without retaining file history. Check the save receipt before claiming persistence.`
      : context.instructions.workingCopy
      ? `Your editable agent instruction file is ${context.instructions.workingCopy.rootPath}/${context.instructions.workingCopy.entryPath}. Edit this registered private copy normally. After this run stops, Paperclip saves changed content as a persistent revision if your responsible user still has permission and the baseline has not changed. Check the run's instruction-save receipt before claiming persistence. Conflicts are preserved for explicit resolution. Repository instruction files, skills, and this run's loaded prompt are separate and are not collected.`
      : null,
    // Keep this canonical suffix intact for provider-specific asset remapping.
    `Read-only instruction sibling root: ${context.instructions.bundle.rootPath}`,
  ].filter(Boolean).join("\n\n");
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

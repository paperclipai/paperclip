import { realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  CODEX_BLOCK_TOOL_NAME,
  CODEX_COMPLETION_TOOL_NAME,
} from "../../contracts/codex.js";
import type { PrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { redactCodexDiagnostic } from "./app-server-transport.js";

const MAX_RETAINED_CODEX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RETAINED_CODEX_STRING_CHARS = 32 * 1024;
const SENSITIVE_HOST_HOME_DIRECTORIES = [
  ".aws",
  ".azure",
  ".codex",
  ".config/gcloud",
  ".gnupg",
  ".kube",
  ".ssh",
] as const;

export type CodexWorkingDirectoryAuthority =
  "local_filesystem" | "remote_runner";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function validateCodexWorkingDirectory(
  workingDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  authority: CodexWorkingDirectoryAuthority = "local_filesystem",
): string {
  if (workingDirectory.trim().length === 0) {
    throw new Error("Codex working directory is required");
  }
  if (authority === "remote_runner") {
    return validateRemoteRunnerWorkingDirectory(workingDirectory, environment);
  }
  const requested = resolve(workingDirectory);
  let resolved: string;
  try {
    resolved = realpathSync.native(requested);
    if (!statSync(resolved).isDirectory()) {
      throw new Error("Codex working directory must be a directory");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        "Codex working directory must exist before provider admission",
      );
    }
    throw error;
  }
  if (resolved === parse(resolved).root) {
    throw new Error("Codex working directory cannot be a filesystem root");
  }
  const configuredRoot = environment.PAPERCLIP_WORKSPACE_CWD;
  const hostHome = canonicalConfiguredPath(environment.HOME);
  if (hostHome && pathContains(resolved, hostHome)) {
    throw new Error("Codex working directory cannot contain the host HOME");
  }
  if (
    hostHome &&
    SENSITIVE_HOST_HOME_DIRECTORIES.some((directory) =>
      pathContains(resolve(hostHome, directory), resolved),
    )
  ) {
    throw new Error(
      "Codex working directory cannot overlap sensitive host HOME state",
    );
  }
  if (
    hostHome &&
    pathContains(hostHome, resolved) &&
    (configuredRoot === undefined || configuredRoot.trim().length === 0)
  ) {
    throw new Error(
      "Codex working directory inside the host HOME requires an assigned workspace",
    );
  }
  const codexHome = canonicalConfiguredPath(environment.CODEX_HOME);
  if (codexHome) {
    if (
      pathContains(resolved, codexHome) ||
      pathContains(codexHome, resolved)
    ) {
      throw new Error("Codex working directory cannot overlap host CODEX_HOME");
    }
  }
  if (configuredRoot !== undefined && configuredRoot.trim().length > 0) {
    const root = canonicalConfiguredPath(configuredRoot)!;
    const pathFromRoot = relative(root, resolved);
    if (
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw new Error(
        "Codex working directory is outside the assigned workspace",
      );
    }
  }
  return resolved;
}

function validateRemoteRunnerWorkingDirectory(
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (
    !posix.isAbsolute(workingDirectory) ||
    posix.normalize(workingDirectory) !== workingDirectory ||
    /[\u0000-\u001f\u007f]/u.test(workingDirectory)
  ) {
    throw new Error(
      "Remote Codex working directory must be a normalized absolute path",
    );
  }
  if (workingDirectory === posix.parse(workingDirectory).root) {
    throw new Error("Codex working directory cannot be a filesystem root");
  }
  const configuredRoot = environment.PAPERCLIP_WORKSPACE_CWD?.trim();
  if (!configuredRoot) {
    throw new Error(
      "Remote Codex working directory requires an assigned workspace",
    );
  }
  if (
    !posix.isAbsolute(configuredRoot) ||
    posix.normalize(configuredRoot) !== configuredRoot
  ) {
    throw new Error(
      "Assigned remote workspace must be a normalized absolute path",
    );
  }
  // The controller cannot inspect a provider-owned filesystem. Pin the facade
  // to the exact remote workspace while runnerd validates existence, type, and
  // canonical identity inside the authoritative filesystem before launch.
  if (workingDirectory !== configuredRoot) {
    throw new Error(
      "Remote Codex working directory does not match the assigned workspace",
    );
  }
  return workingDirectory;
}

function canonicalConfiguredPath(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;
  return canonicalPathWithMissingTail(resolve(configured));
}

function canonicalPathWithMissingTail(path: string): string {
  let cursor = path;
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync.native(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`) &&
      !isAbsolute(fromParent))
  );
}

export function boundedCodexValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return { truncated: true, reason: "maximum depth" };
  if (typeof value === "string") {
    return value.length <= MAX_RETAINED_CODEX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_RETAINED_CODEX_STRING_CHARS)}...[truncated]`;
  }
  if (Array.isArray(value)) {
    const bounded = value
      .slice(0, 128)
      .map((entry) => boundedCodexValue(entry, depth + 1));
    if (value.length > 128) {
      bounded.push({ truncated: true, omittedItems: value.length - 128 });
    }
    return bounded;
  }
  if (typeof value !== "object" || value === null) return value;
  const object = record(value);
  const bounded = Object.fromEntries(
    Object.entries(object)
      .slice(0, 128)
      .map(([key, entry]) => [key, boundedCodexValue(entry, depth + 1)]),
  );
  if (Object.keys(object).length > 128) {
    bounded.truncatedEntries = Object.keys(object).length - 128;
  }
  const serialized = JSON.stringify(bounded);
  return Buffer.byteLength(serialized) <= MAX_RETAINED_CODEX_PAYLOAD_BYTES
    ? bounded
    : { truncated: true, byteSize: Buffer.byteLength(serialized) };
}

export function boundedCodexPayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return record(boundedCodexValue(value));
}

export function isRetainableCodexPayload(value: unknown): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify(value)) <=
      MAX_RETAINED_CODEX_PAYLOAD_BYTES
    );
  } catch {
    return false;
  }
}

export function isCodexSemanticTool(tool: string): boolean {
  return tool === CODEX_COMPLETION_TOOL_NAME || tool === CODEX_BLOCK_TOOL_NAME;
}

export function codexToolAcceptsDisposition(
  tool: string,
  disposition: PrpStructuredRunResult["reportedWorkDisposition"],
): boolean {
  if (tool === CODEX_BLOCK_TOOL_NAME) {
    return disposition === "blocked";
  }
  if (tool === CODEX_COMPLETION_TOOL_NAME) {
    return disposition === "done" || disposition === "needs_review";
  }
  return false;
}

export function redactCodexValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactCodexDiagnostic(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 128)
      .map((entry) => redactCodexValue(entry, depth + 1));
  }
  const object = record(value);
  return Object.fromEntries(
    Object.entries(object)
      .slice(0, 128)
      .map(([key, entry]) => [
        key,
        /(?:api[_-]?key|token|secret|password|authorization)/i.test(key)
          ? "[REDACTED]"
          : redactCodexValue(entry, depth + 1),
      ]),
  );
}

export function rejectedCodexToolCall(
  message: string,
): Record<string, unknown> {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  };
}

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";

export interface AcpxAgentFilesBinding {
  readonly root: string;
  assertHeld(): void;
}

/** The authenticated runtime context, never an ambient environment value, grants this run copy. */
export function bindAcpxAgentFiles(
  context: NativeRuntimeContextSnapshot | null | undefined,
  protectedRoots: readonly string[],
): AcpxAgentFilesBinding | null {
  const copy = context?.instructions.workingCopy;
  const persistentHome = context?.persistentAgentHome;
  if (!persistentHome && copy?.kind !== "agent_files") return null;
  const declared = persistentHome?.rootPath ?? copy!.rootPath;
  if (!isAbsolute(declared) || declared.includes("\0") || resolve(declared) !== declared) {
    throw new Error("ACP agent directory must be an absolute normalized registered path");
  }
  const metadata = lstatSync(declared);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("ACP agent directory must be a real directory");
  }
  const root = realpathSync(declared);
  if (resolve(root, "..") === root) throw new Error("ACP agent directory cannot be a filesystem root");
  for (const protectedRoot of protectedRoots) {
    // These roots belong to the verified runtime and sandbox, not user input.
    const canonical = realpathSync(protectedRoot);
    // Attached-computer homes contain the runner's isolated state beneath
    // .paperclip-runtime. This env pointer does not widen the provider policy;
    // retain its protected roots, and never alias the home into one of them.
    if (contains(canonical, root) || (!persistentHome && contains(root, canonical))) {
      throw new Error("ACP agent directory overlaps protected runtime state");
    }
  }
  const assertHeld = () => {
    const current = lstatSync(declared);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== metadata.dev || current.ino !== metadata.ino
      || realpathSync(declared) !== root) {
      throw new Error("ACP registered agent directory changed during provider lifetime");
    }
  };
  return Object.freeze({ root, assertHeld });
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

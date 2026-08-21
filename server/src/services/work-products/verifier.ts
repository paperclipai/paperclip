import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkProductHealth } from "./completion-gate.js";

const execFileAsync = promisify(execFile);

export interface VerifiableWorkProduct {
  type: string;
  provider: string;
  externalId: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface VerifierDeps {
  /** Absolute roots a declared file path may live under. Anything else is refused. */
  roots: string[];
  fileHasContent: (absolutePath: string) => Promise<boolean>;
  /** `root` is the repo to ask — a SHA only exists in its own repo, not in every root. */
  commitExists: (sha: string, root: string) => Promise<boolean>;
  commitTouchesPath: (sha: string, filePath: string, root: string) => Promise<boolean>;
  documentHasBody: (documentId: string) => Promise<boolean>;
  urlIsReachable: (url: string) => Promise<boolean>;
}

/** The configured root a resolved absolute path sits under. */
function rootOf(absolutePath: string, roots: string[]): string | null {
  return roots.find((root) => isInside(absolutePath, root)) ?? null;
}

/**
 * Maps a declared path onto the absolute paths it could mean. A path that escapes every root
 * resolves to nothing — an agent must not point the verifier at arbitrary files.
 */
export function resolveFileCandidates(declaredPath: string, roots: string[]): string[] {
  const trimmed = declaredPath.trim().replace(/^\.\//, "");
  if (!trimmed) return [];

  if (path.isAbsolute(trimmed)) {
    const normalized = path.normalize(trimmed);
    return roots.some((root) => isInside(normalized, root)) ? [normalized] : [];
  }

  return roots
    .map((root) => path.normalize(path.join(root, trimmed)))
    .filter((candidate, index) => isInside(candidate, roots[index]));
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.normalize(root), candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function verifyWorkProduct(
  product: VerifiableWorkProduct,
  deps: VerifierDeps,
): Promise<WorkProductHealth> {
  switch (product.type) {
    case "file": {
      const declaredPath = readString(product.externalId);
      if (!declaredPath) return "missing";

      const candidates = resolveFileCandidates(declaredPath, deps.roots);
      const found: string[] = [];
      for (const candidate of candidates) {
        if (await deps.fileHasContent(candidate)) found.push(candidate);
      }
      if (found.length === 0) return "missing";

      // A commit claim is part of the claim: the named commit must actually touch this file.
      // It is checked in the repo the file was found in — a SHA from the vault does not exist
      // in the code repo, and asking the wrong one reports real work as missing.
      const commit = readString(product.metadata?.commit);
      if (commit) {
        const roots = found
          .map((candidate) => rootOf(candidate, deps.roots))
          .filter((root): root is string => Boolean(root));
        for (const root of roots) {
          if (
            (await deps.commitExists(commit, root))
            && (await deps.commitTouchesPath(commit, declaredPath, root))
          ) {
            return "verified";
          }
        }
        return "missing";
      }
      return "verified";
    }

    case "commit": {
      const sha = readString(product.externalId);
      if (!sha) return "missing";
      for (const root of deps.roots) {
        if (await deps.commitExists(sha, root)) return "verified";
      }
      return "missing";
    }

    case "document": {
      const documentId = readString(product.externalId);
      if (!documentId) return "missing";
      return (await deps.documentHasBody(documentId)) ? "verified" : "missing";
    }

    case "url": {
      const url = readString(product.url) ?? readString(product.externalId);
      if (!url) return "missing";
      return (await deps.urlIsReachable(url)) ? "verified" : "missing";
    }

    default:
      // Unknown shapes are not blocked — the gate treats only "verified" as passing, but an
      // issue that expects an unverifiable type simply cannot pin one.
      return "unknown";
  }
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
    return stdout;
  } catch {
    return null;
  }
}

/** Real IO. Commit queries run in the repo they are asked about, not in a fixed one. */
export function createVerifierDeps(input: {
  roots: string[];
  documentHasBody: (documentId: string) => Promise<boolean>;
}): VerifierDeps {
  return {
    roots: input.roots,
    fileHasContent: async (absolutePath) => {
      try {
        const info = await stat(absolutePath);
        return info.isFile() && info.size > 0;
      } catch {
        return false;
      }
    },
    commitExists: async (sha, root) => {
      const out = await git(["cat-file", "-t", sha], root);
      return out?.trim() === "commit";
    },
    commitTouchesPath: async (sha, filePath, root) => {
      const out = await git(["show", "--name-only", "--format=", sha], root);
      if (!out) return false;
      const wanted = filePath.trim().replace(/^\.\//, "");
      return out.split("\n").some((line) => line.trim() === wanted);
    },
    documentHasBody: input.documentHasBody,
    urlIsReachable: async (url) => {
      try {
        const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

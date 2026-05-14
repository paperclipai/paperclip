import { realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve, sep } from "node:path";

export type ValidationCode =
  | "NOT_FOUND"
  | "OUTSIDE_ROOTS"
  | "BAD_PATH";

export class ValidationError extends Error {
  constructor(public code: ValidationCode, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function expandTilde(input: string): string {
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\")) {
    return homedir() + input.slice(1);
  }
  return input;
}

function expandWindowsEnv(input: string): string {
  if (platform() !== "win32") return input;
  // %USERPROFILE%, %APPDATA%, %LOCALAPPDATA% — restricted allowlist
  const ALLOWED = ["USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  return input.replace(/%([^%]+)%/g, (match, name) => {
    if (!ALLOWED.includes(name)) return match;
    const value = process.env[name];
    return value ?? match;
  });
}

function stripFileScheme(input: string): string {
  if (input.startsWith("file:///")) return input.slice(7);
  if (input.startsWith("file://")) return input.slice(6);
  return input;
}

function decodeUrl(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function pathsEqualOrInside(child: string, parent: string): boolean {
  const isWin = platform() === "win32";
  const a = isWin ? child.toLowerCase() : child;
  const b = isWin ? parent.toLowerCase() : parent;
  if (a === b) return true;
  const prefix = b.endsWith(sep) ? b : b + sep;
  return a.startsWith(prefix);
}

export function validatePath(rawPath: string, roots: string[]): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ValidationError("BAD_PATH", "path is empty");
  }

  let working = rawPath;
  working = stripFileScheme(working);
  working = decodeUrl(working);
  working = expandTilde(working);
  working = expandWindowsEnv(working);
  const resolved = resolve(working);

  // Resolve symlinks — needed for both existence check and security comparison
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    throw new ValidationError("NOT_FOUND", `file not found: ${rawPath}`);
  }

  // Resolve roots through realpathSync so comparison uses canonical paths on all
  // platforms (e.g. macOS where /var -> /private/var).
  const realRoots = roots.map((root) => {
    const expanded = expandWindowsEnv(expandTilde(root));
    return realpathSync(resolve(expanded));
  });

  const ok = realRoots.some((root) => pathsEqualOrInside(realPath, root));
  if (!ok) {
    throw new ValidationError(
      "OUTSIDE_ROOTS",
      `path outside allowed roots: ${rawPath}`,
    );
  }

  // Return resolved (normalised, but NOT symlink-followed). realpathSync is used
  // only for the security comparison above so that symlink-escape attacks are
  // caught. Returning `resolved` (rather than `realPath`) keeps the path in the
  // same form the caller supplied, avoiding platform-specific symlink surprises
  // (e.g. macOS /var -> /private/var) that would break string equality checks.
  return resolved;
}

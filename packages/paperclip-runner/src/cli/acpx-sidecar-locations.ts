import { isAbsolute, relative, resolve, sep } from "node:path";

export const ACPX_WORKSPACE_RELATIVE_DISPLAY_BOUNDARY =
  "paperclip.workspace_relative_display.v1";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Converts provider paths to workspace-relative display targets using the
 * sidecar host's path semantics. A URI is not a path. Windows separators are
 * canonicalized for PRP; POSIX backslashes and colons remain literal filename
 * characters. Consumers must treat the result as display data, never as an
 * authorization to access a file.
 */
export function safeAcpxLocations(
  locations: readonly unknown[] | null | undefined,
  workingDirectory: string | null | undefined,
): Array<Record<string, unknown>> {
  if (!workingDirectory) return [];
  const cwd = resolve(workingDirectory);
  return (locations ?? []).slice(0, 2_000).flatMap((location) => {
    const candidate = record(location);
    const rawPath = typeof candidate.path === "string" ? candidate.path : "";
    if (!rawPath || rawPath.includes("\0")) return [];
    const absolute = isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(cwd, rawPath);
    const local = relative(cwd, absolute);
    if (!local || isAbsolute(local)) return [];
    const portable = sep === "\\" ? local.replaceAll("\\", "/") : local;
    if (
      portable.startsWith("/") ||
      portable.split("/").some((segment) => segment === "..")
    ) {
      return [];
    }
    return [
      {
        path: [...portable].slice(0, 4_000).join(""),
        line: candidate.line ?? null,
        pathBoundary: ACPX_WORKSPACE_RELATIVE_DISPLAY_BOUNDARY,
      },
    ];
  });
}

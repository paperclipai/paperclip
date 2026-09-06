import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { classifyGeneratedAcpxToolOperation } from "../drivers/acpx/generated-sidecar-contract.js";

export const ACPX_WORKSPACE_RELATIVE_DISPLAY_BOUNDARY =
  "paperclip.workspace_relative_display.v2";
export const ACPX_WORKSPACE_ENTRY_ATTESTATION = "paperclip.workspace_entry.v1";
export const ACPX_WORKSPACE_CREATE_TARGET_ATTESTATION =
  "paperclip.workspace_create_target.v1";
const RFC_URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function permitsCreateTarget(toolKind: unknown, toolTitle: unknown): boolean {
  return classifyGeneratedAcpxToolOperation(toolKind, toolTitle) === "edit";
}

/**
 * Converts provider paths to workspace-relative display targets using the
 * sidecar host's path semantics. URI-scheme and Windows drive-shaped values
 * are ambiguous on POSIX, so they require a real, in-workspace filesystem
 * entry before the sidecar may attest them as filename data. Leading
 * backslashes likewise require native-host attestation because they are rooted
 * syntax on Windows but valid filename data on POSIX. Consumers must
 * treat the result as display data, never as file-access authorization.
 */
export function safeAcpxLocations(
  locations: readonly unknown[] | null | undefined,
  workingDirectory: string | null | undefined,
  toolKind?: unknown,
  toolTitle?: unknown,
): Array<Record<string, unknown>> {
  if (!workingDirectory) return [];
  const cwd = resolve(workingDirectory);
  let canonicalCwd: string | null | undefined;
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
    // Classify the value we actually emit as well as the provider's spelling.
    // Dot-relative and absolute paths can normalize to an ambiguous display
    // target even though their raw forms did not begin with an ambiguous shape.
    const requiresEntryAttestation =
      rawPath.startsWith("\\") ||
      portable.startsWith("\\") ||
      WINDOWS_DRIVE_PREFIX.test(rawPath) ||
      RFC_URI_SCHEME_PREFIX.test(rawPath) ||
      WINDOWS_DRIVE_PREFIX.test(portable) ||
      RFC_URI_SCHEME_PREFIX.test(portable);
    let pathAttestation: string | undefined;
    if (requiresEntryAttestation) {
      if (canonicalCwd === undefined) {
        try {
          canonicalCwd = realpathSync(cwd);
        } catch {
          canonicalCwd = null;
        }
      }
      if (canonicalCwd === null) return [];

      let entryExists = true;
      try {
        lstatSync(absolute);
      } catch (error) {
        entryExists = false;
        if (
          !permitsCreateTarget(toolKind, toolTitle) ||
          !(
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          return [];
        }
      }

      if (entryExists) {
        try {
          const canonicalEntry = realpathSync(absolute);
          const entryRelative = relative(canonicalCwd, canonicalEntry);
          if (
            !entryRelative ||
            isAbsolute(entryRelative) ||
            entryRelative.split(sep).some((segment) => segment === "..")
          ) {
            return [];
          }
          pathAttestation = ACPX_WORKSPACE_ENTRY_ATTESTATION;
        } catch {
          // An existing but unresolved entry includes dangling links. It must
          // not be downgraded to a create target by an ENOENT from realpath.
          return [];
        }
      } else {
        try {
          const canonicalParent = realpathSync(dirname(absolute));
          const parentRelative = relative(canonicalCwd, canonicalParent);
          if (
            isAbsolute(parentRelative) ||
            parentRelative.split(sep).some((segment) => segment === "..")
          ) {
            return [];
          }
          pathAttestation = ACPX_WORKSPACE_CREATE_TARGET_ATTESTATION;
        } catch {
          return [];
        }
      }
    }
    return [
      {
        path: [...portable].slice(0, 4_000).join(""),
        line: candidate.line ?? null,
        pathBoundary: ACPX_WORKSPACE_RELATIVE_DISPLAY_BOUNDARY,
        ...(pathAttestation ? { pathAttestation } : {}),
      },
    ];
  });
}

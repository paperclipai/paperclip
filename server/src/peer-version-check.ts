// Exact-version peer-dependency gate, shared by every optional-SDK bootstrap
// (OpenTelemetry in `instrumentation.ts`, Sentry in `sentry.ts`).
//
// This module has no module-init side effect — it only defines functions. A
// bootstrap module imports it and calls `checkExactPeerVersions` itself. That
// matters for `sentry.ts`: a direct import of `instrumentation.ts` would run
// the OpenTelemetry bootstrap (`instrumentationReady`) as a side effect of
// loading the Sentry gate, which this module avoids.
//
// Fail-closed contract: every failure this module can hit — an unreadable
// manifest, malformed JSON, a `peerDependencies` entry the manifest does not
// declare, a package that is not installed, or a package installed at the
// wrong version — resolves to `{ ok: false }`. None of these conditions
// silently pass the gate as if no check applied.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PeerDependencyManifestResult =
  | { ok: true; peerDependencies: Record<string, string> }
  | { ok: false; reason: string };

function describeParseError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a `package.json` document's `peerDependencies` map. Exported so a
 * test can exercise malformed-content handling directly, without touching the
 * filesystem. A document with no `peerDependencies` key parses to an empty
 * map — not a failure — because the failure that matters is a caller asking
 * about a package the map does not name; `checkExactPeerVersions` reports
 * that per package as `undeclared`.
 */
export function parsePeerDependenciesManifest(raw: string): PeerDependencyManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `the manifest is not valid JSON: ${describeParseError(err)}` };
  }

  const peerDependencies = (parsed as { peerDependencies?: unknown } | null)?.peerDependencies;
  if (peerDependencies === undefined) return { ok: true, peerDependencies: {} };
  if (typeof peerDependencies !== "object" || peerDependencies === null || Array.isArray(peerDependencies)) {
    return { ok: false, reason: "the manifest's peerDependencies field is not an object" };
  }
  return { ok: true, peerDependencies: peerDependencies as Record<string, string> };
}

/**
 * Read this package's own `peerDependencies`, so the exact-version gate
 * compares an installed package against the same version this manifest
 * declares — one source of truth, not a second hardcoded copy.
 *
 * A missing or unreadable `server/package.json` is a failed check, not an
 * empty peer map: it reports the filesystem error code only (e.g. `ENOENT`),
 * never the resolved path, so the diagnostic stays safe to log.
 */
function readOwnPeerDependencies(): PeerDependencyManifestResult {
  let raw: string;
  try {
    raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : "unknown error";
    return { ok: false, reason: `server/package.json could not be read (${code})` };
  }
  return parsePeerDependenciesManifest(raw);
}

/**
 * Resolve `packageName` with the same ESM loader algorithm a subsequent
 * `import()` of that name uses, then read the resolved package's own
 * `package.json` for its declared `version`.
 *
 * `import.meta.resolve` matters here, not `require.resolve`: a CommonJS
 * resolver honors `NODE_PATH` and can therefore find a different package
 * than the ESM `import()` a bootstrap runs afterward would load — so a
 * `require.resolve`-based check could pass a package it never actually
 * loads. `import.meta.resolve` never consults `NODE_PATH`. Called from the
 * same directory as the bootstrap's own `import()` (both `sentry.ts` and
 * `instrumentation.ts` sit next to this module), it resolves to the exact
 * file the bootstrap's `import()` of the same specifier loads — the checked
 * entry and the executed entry cannot diverge.
 *
 * Walks up from the resolved entry file to find the nearest `package.json`
 * whose `name` matches, instead of resolving `${packageName}/package.json`
 * directly: several `@opentelemetry/*` packages do not expose `./package.json`
 * as an `exports` subpath, even though the package is correctly installed.
 *
 * Returns `null` when the package cannot be resolved, or when the walk finds
 * no `package.json` naming this package.
 */
function resolveInstalledPackage(packageName: string): { version: string; resolvedUrl: string } | null {
  let resolvedUrl: string;
  try {
    resolvedUrl = import.meta.resolve(packageName);
  } catch {
    return null;
  }
  try {
    let dir = dirname(fileURLToPath(resolvedUrl));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name === packageName) {
          return typeof parsed.version === "string" ? { version: parsed.version, resolvedUrl } : null;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Verify that every package in `packageNames` is installed at the exact
 * version `peerDependencies` declares. The caller passes only the packages it
 * needs checked — the OpenTelemetry bootstrap passes the four common packages
 * plus the one exporter `OTEL_EXPORTER_OTLP_PROTOCOL` selected, and the
 * Sentry gate passes `["@sentry/node"]`. Never throws: every failure this
 * function can hit resolves to a reported issue, not an exception.
 *
 * When the caller omits `peerDependencies`, this reads it from this
 * manifest's own declared versions (`readOwnPeerDependencies()`) — what each
 * real bootstrap uses. A test passes an explicit map instead, so it can check
 * the comparison logic against a package it controls without writing into
 * `node_modules`. An explicit empty map (`{}`) is a valid input distinct from
 * "omitted" — it means every requested package is undeclared, which fails
 * closed the same as an unreadable manifest would.
 *
 * On success, `resolved` maps each checked package name to the exact module
 * URL `resolveInstalledPackage` used to read its version. A caller can pass
 * that URL straight to its own `import()` — the same string used for the
 * check is the string the bootstrap loads, so the two cannot diverge.
 *
 * The returned `diagnostic` string names the OpenTelemetry endpoint variable,
 * because the OpenTelemetry bootstrap logs it directly. The Sentry gate reads
 * `detail` instead and builds its own diagnostic line — see `sentry.ts`.
 */
export function checkExactPeerVersions(
  packageNames: readonly string[],
  peerDependencies?: Record<string, string>,
):
  | { ok: true; resolved: Record<string, string> }
  | { ok: false; diagnostic: string; detail: unknown } {
  let declaredVersions: Record<string, string>;
  if (peerDependencies !== undefined) {
    declaredVersions = peerDependencies;
  } else {
    const manifest = readOwnPeerDependencies();
    if (!manifest.ok) {
      return {
        ok: false,
        diagnostic:
          "[paperclip] could not read the server manifest's declared peer-dependency " +
          `versions (${manifest.reason}). Continuing with the optional feature disabled.`,
        detail: { manifestError: manifest.reason },
      };
    }
    declaredVersions = manifest.peerDependencies;
  }

  const undeclared: string[] = [];
  const missing: string[] = [];
  const mismatched: { name: string; installed: string; expected: string }[] = [];
  const resolved: Record<string, string> = {};

  for (const name of packageNames) {
    const expected = declaredVersions[name];
    if (expected === undefined) {
      undeclared.push(name);
      continue;
    }
    const installedPackage = resolveInstalledPackage(name);
    if (installedPackage === null) {
      missing.push(name);
    } else if (installedPackage.version !== expected) {
      mismatched.push({ name, installed: installedPackage.version, expected });
    } else {
      resolved[name] = installedPackage.resolvedUrl;
    }
  }

  if (missing.length === 0 && mismatched.length === 0 && undeclared.length === 0) {
    return { ok: true, resolved };
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`the @opentelemetry/* packages are not installed: ${missing.join(", ")}`);
  }
  if (mismatched.length > 0) {
    const detail = mismatched
      .map((m) => `${m.name}@${m.installed} (expected ${m.expected})`)
      .join(", ");
    parts.push(`a package is installed at an unsupported version: ${detail}`);
  }
  if (undeclared.length > 0) {
    parts.push(`the server manifest declares no expected version for: ${undeclared.join(", ")}`);
  }

  return {
    ok: false,
    diagnostic:
      `[paperclip] OTEL_EXPORTER_OTLP_ENDPOINT is set but ${parts.join("; and ")}. ` +
      "Continuing without tracing.",
    detail: { missing, mismatched, undeclared },
  };
}

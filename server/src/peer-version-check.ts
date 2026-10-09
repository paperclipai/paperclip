// Exact-version peer-dependency gate, shared by every optional-SDK bootstrap
// (OpenTelemetry in `instrumentation.ts`, Sentry in `sentry.ts`).
//
// This module has no module-init side effect — it only defines functions. A
// bootstrap module imports it and calls `checkExactPeerVersions` itself. That
// matters for `sentry.ts`: a direct import of `instrumentation.ts` would run
// the OpenTelemetry bootstrap (`instrumentationReady`) as a side effect of
// loading the Sentry gate, which this module avoids.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Read this package's own `peerDependencies`, so the exact-version gate
 * compares an installed package against the same version this manifest
 * declares — one source of truth, not a second hardcoded copy. Returns an
 * empty map on any read or parse failure (fail open: an unreadable manifest
 * skips the version check rather than blocking startup).
 */
function readOwnPeerDependencies(): Record<string, string> {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const parsed = JSON.parse(raw) as { peerDependencies?: Record<string, string> };
    return parsed.peerDependencies ?? {};
  } catch {
    return {};
  }
}

/**
 * Read an installed package's own declared `version`, without importing or
 * executing the package. Resolves the package's main entry point (which
 * respects its `exports` map) and then walks up the filesystem to the
 * nearest `package.json` whose `name` matches — a direct
 * `require.resolve(\`${packageName}/package.json\`)` throws for a package
 * whose `exports` map does not expose `./package.json` as a subpath, which
 * several `@opentelemetry/*` packages do not, even though the package is
 * correctly installed. Returns null when the package cannot be resolved or no
 * matching `package.json` is found.
 */
function readInstalledPackageVersion(packageName: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(packageName));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name === packageName) {
          return typeof parsed.version === "string" ? parsed.version : null;
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
 * Sentry gate passes `["@sentry/node"]`. Never throws: a missing manifest, a
 * missing package, or an unreadable `package.json` all resolve to a reported
 * issue, not an exception.
 *
 * `peerDependencies` defaults to this manifest's own declared versions
 * (`readOwnPeerDependencies()`), which is what each bootstrap uses. A test
 * passes an explicit map instead, so it can check the comparison logic
 * against a package it controls without writing into `node_modules`.
 *
 * The returned `diagnostic` string names the OpenTelemetry endpoint variable,
 * because the OpenTelemetry bootstrap logs it directly. The Sentry gate reads
 * `detail` instead and builds its own diagnostic line — see `sentry.ts`.
 */
export function checkExactPeerVersions(
  packageNames: readonly string[],
  peerDependencies: Record<string, string> = readOwnPeerDependencies(),
): { ok: true } | { ok: false; diagnostic: string; detail: unknown } {
  const missing: string[] = [];
  const mismatched: { name: string; installed: string; expected: string }[] = [];

  for (const name of packageNames) {
    const expected = peerDependencies[name];
    const installed = readInstalledPackageVersion(name);
    if (installed === null) {
      missing.push(name);
    } else if (expected && installed !== expected) {
      mismatched.push({ name, installed, expected });
    }
  }

  if (missing.length === 0 && mismatched.length === 0) return { ok: true };

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

  return {
    ok: false,
    diagnostic:
      `[paperclip] OTEL_EXPORTER_OTLP_ENDPOINT is set but ${parts.join("; and ")}. ` +
      "Continuing without tracing.",
    detail: { missing, mismatched },
  };
}

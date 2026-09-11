import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `doc/observability.md` audits the browser Sentry privacy behavior against
 * one exact `@sentry/browser` release. A caret range lets a lockfile refresh
 * move the installed version and silently invalidate that audit. This test
 * guards the manifest: the declared version must be exact, not a range.
 */

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("ui package Sentry version pin", () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("pins @sentry/browser to an exact version", () => {
    const declared = packageJson.devDependencies?.["@sentry/browser"];
    expect(declared).toBeDefined();
    // An exact version has no range operator (^, ~, >=, ||, x, *, …). A
    // caret range such as "^10.71.0" must fail this assertion.
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps @sentry/browser a development dependency, not a normal dependency", () => {
    expect(packageJson.dependencies?.["@sentry/browser"]).toBeUndefined();
    expect(packageJson.devDependencies?.["@sentry/browser"]).toBeDefined();
  });
});

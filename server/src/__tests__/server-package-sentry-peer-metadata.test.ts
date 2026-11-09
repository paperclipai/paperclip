import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `server/src/sentry.ts` loads `@sentry/node` through a dynamic import. It
 * must be an optional peer dependency, not a normal dependency, so a default
 * install never pulls in the SDK. This test guards the manifest half of that
 * contract; `sentry.test.ts` guards the runtime half (the bootstrap fails
 * open when the package is absent or at an unsupported version).
 */

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("server package Sentry peer metadata", () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it("declares @sentry/node as an optional peer dependency", () => {
    expect(packageJson.peerDependencies?.["@sentry/node"]).toBeDefined();
    expect(packageJson.peerDependenciesMeta?.["@sentry/node"]?.optional).toBe(true);
  });

  it("does not list @sentry/node in dependencies or devDependencies", () => {
    expect(packageJson.dependencies?.["@sentry/node"]).toBeUndefined();
    expect(packageJson.devDependencies?.["@sentry/node"]).toBeUndefined();
  });
});

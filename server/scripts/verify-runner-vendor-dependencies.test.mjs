import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findMissingVendorDependencies,
  findRunnerExternalPackages,
  findRunnerRuntimePackages,
} from "./verify-runner-vendor-dependencies.mjs";

describe("findMissingVendorDependencies", () => {
  it("returns nothing when every runner dependency is already declared on server", () => {
    const missing = findMissingVendorDependencies(
      new Set(["acpx", "ajv", "smol-toml"]),
      new Set(["acpx", "ajv", "smol-toml", "express"]),
    );

    expect(missing).toEqual([]);
  });

  it("flags a runner dependency that isn't mirrored into server/package.json", () => {
    // This is the exact shape of the incident this check exists to catch:
    // packages/paperclip-runner/package.json grew a new runtime dependency
    // (smol-toml) that never got mirrored into server/package.json, so the
    // vendored `cp -R` copy failed to resolve it at runtime (#13110, #13116).
    const missing = findMissingVendorDependencies(
      new Set(["acpx", "ajv", "smol-toml"]),
      new Set(["acpx", "ajv"]),
    );

    expect(missing).toEqual(["smol-toml"]);
  });

  it("sorts multiple missing dependencies for a stable error message", () => {
    const missing = findMissingVendorDependencies(
      new Set(["smol-toml", "ajv-formats", "acpx"]),
      new Set(),
    );

    expect(missing).toEqual(["acpx", "ajv-formats", "smol-toml"]);
  });
});

describe("findRunnerExternalPackages", () => {
  // Fixture-level coverage for the actual esbuild scan, not just the diff
  // function: a real dist/index.js + dist/testing.js on disk, structurally
  // matching packages/paperclip-runner's shape (testing.js re-exports
  // index.js, which imports another local module that imports a bare npm
  // specifier), plus package.json dependency noise that should be ignored
  // because nothing reachable from these entry points imports it.
  let fixtureDir;

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  function writeFixture() {
    fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-runner-vendor-fixture-"));
    writeFileSync(
      join(fixtureDir, "internal.js"),
      'import { parse } from "smol-toml";\n' +
        "export function parseSomething(text) { return parse(text); }\n",
    );
    writeFileSync(
      join(fixtureDir, "index.js"),
      'export * from "./internal.js";\nexport const marker = "index";\n',
    );
    writeFileSync(
      join(fixtureDir, "testing.js"),
      'export * from "./index.js";\nexport const testingMarker = "testing";\n',
    );
    return [join(fixtureDir, "index.js"), join(fixtureDir, "testing.js")];
  }

  it("reports only the npm packages actually reachable from the entry points", async () => {
    const entryPoints = writeFixture();

    const externalPackageNames = await findRunnerExternalPackages(entryPoints);

    // smol-toml is reachable through internal.js -> index.js -> testing.js
    // and must be reported. Nothing else was imported anywhere in the
    // fixture, so this also proves the scan doesn't fall back to "every
    // dependency the package declares" (which is what made the check
    // over-broad before -- see the module header).
    expect(externalPackageNames).toEqual(new Set(["smol-toml"]));
  });

  it("checks dynamically resolved bundled providers even without a JavaScript import", async () => {
    const entryPoints = writeFixture();
    const profiles = JSON.parse(readFileSync(new URL("../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
    const packages = await findRunnerRuntimePackages(entryPoints, profiles);
    expect(findMissingVendorDependencies(packages, new Set(["smol-toml", "@agentclientprotocol/codex-acp"])))
      .toEqual(["@agentclientprotocol/claude-agent-acp"]);
    expect(packages.has("pi-acp")).toBe(false);
  });

  it("throws a clear, actionable error when an entry point is missing", async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-runner-vendor-fixture-"));
    const missingEntryPoint = join(fixtureDir, "index.js");

    await expect(findRunnerExternalPackages([missingEntryPoint])).rejects.toThrow(
      /expected build output at .*index\.js.*Run "pnpm --filter @paperclipai\/paperclip-runner build" first/s,
    );
  });
});

// Claude is resolved through createRequire at runtime, outside esbuild's graph.
it("ships the qualified Claude ACP server with the vendored runner", () => {
  const server = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const profiles = JSON.parse(readFileSync(new URL("../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
  const claude = profiles.profiles.claude;
  expect(server.dependencies[claude.agentServerPackage]).toBe(claude.agentServerVersion);
  expect(server.bundleDependencies).toContain(claude.agentServerPackage);
});

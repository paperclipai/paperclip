import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const mockStore = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock("../services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: () => mockStore.records,
  getAdapterPluginsDir: () => "/nonexistent/external-adapters",
  getAdapterPluginByType: () => undefined,
}));

import { buildExternalAdapters } from "../adapters/plugin-loader.js";

const HEALTHY_SOURCE = `export function createServerAdapter() {
  return { type: ${JSON.stringify("fixture_healthy")} };
}
`;

const HANGING_SOURCE = `await new Promise(() => {});
export function createServerAdapter() {
  return { type: "fixture_hanging" };
}
`;

function writeFixturePackage(root: string, name: string, source: string): string {
  const packageDir = path.join(root, name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name, type: "module", main: "index.js" }),
  );
  writeFileSync(path.join(packageDir, "index.js"), source);
  return packageDir;
}

function recordFor(packageDir: string, packageName: string, type: string) {
  return {
    packageName,
    localPath: packageDir,
    type,
    installedAt: new Date(0).toISOString(),
  };
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "paperclip-adapter-load-"));
  mockStore.records = [];
});

afterEach(() => {
  vi.useRealTimers();
  mockStore.records = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("buildExternalAdapters load budget", () => {
  it("loads a healthy external adapter unchanged", async () => {
    const packageDir = writeFixturePackage(root, "fixture-healthy", HEALTHY_SOURCE);
    mockStore.records = [recordFor(packageDir, "fixture-healthy", "fixture_healthy")];

    const adapters = await buildExternalAdapters({ timeoutMs: 5_000 });

    expect(adapters.map((adapter) => adapter.type)).toEqual(["fixture_healthy"]);
  }, 10_000);

  it("returns once the budget elapses when a package import never resolves", async () => {
    const hangingDir = writeFixturePackage(root, "fixture-hanging", HANGING_SOURCE);
    const healthyDir = writeFixturePackage(root, "fixture-healthy", HEALTHY_SOURCE);
    mockStore.records = [
      recordFor(hangingDir, "fixture-hanging", "fixture_hanging"),
      recordFor(healthyDir, "fixture-healthy", "fixture_healthy"),
    ];

    const startedAt = Date.now();
    const adapters = await buildExternalAdapters({ timeoutMs: 200 });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(adapters.map((adapter) => adapter.type)).toEqual(["fixture_healthy"]);
  }, 10_000);
});

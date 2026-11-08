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

import { buildExternalAdapters, getUiParserSource } from "../adapters/plugin-loader.js";

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

const SLOW_SOURCE = `await new Promise((resolve) => setTimeout(resolve, 300));
export function createServerAdapter() {
  return { type: "fixture_slow" };
}
`;

function writeSlowPackageWithUiParser(root: string): string {
  const packageDir = writeFixturePackage(root, "fixture-slow", SLOW_SOURCE);
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "fixture-slow",
      type: "module",
      exports: { ".": "./index.js", "./ui-parser": "./ui-parser.js" },
    }),
  );
  writeFileSync(path.join(packageDir, "ui-parser.js"), "export const parse = () => [];");
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

  it("does not cache the UI parser of an import that finishes after the budget", async () => {
    const slowDir = writeSlowPackageWithUiParser(root);
    mockStore.records = [recordFor(slowDir, "fixture-slow", "fixture_slow")];

    const adapters = await buildExternalAdapters({ timeoutMs: 50 });
    expect(adapters).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(getUiParserSource("fixture_slow")).toBeUndefined();
  }, 10_000);
});

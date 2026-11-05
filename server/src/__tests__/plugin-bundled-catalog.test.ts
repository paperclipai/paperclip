import { afterEach, describe, expect, it, vi } from "vitest";

type FaultOperation = "readFile" | "readdir" | "access";
type Fault = { operation: FaultOperation; pathSuffix: string; code: string };

const fsControl = vi.hoisted(() => ({ fault: null as Fault | null }));
const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const throwFaultOnce = (operation: FaultOperation, target: unknown) => {
    const fault = fsControl.fault;
    if (!fault || fault.operation !== operation) return;
    if (!String(target).replaceAll("\\", "/").endsWith(fault.pathSuffix)) return;
    fsControl.fault = null;
    throw Object.assign(new Error(`${fault.code}: injected ${operation} failure`), { code: fault.code });
  };
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      throwFaultOnce("readFile", args[0]);
      return actual.readFile(...args);
    }),
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      throwFaultOnce("readdir", args[0]);
      return actual.readdir(...args);
    }),
    access: vi.fn(async (...args: Parameters<typeof actual.access>) => {
      throwFaultOnce("access", args[0]);
      return actual.access(...args);
    }),
  };
});

vi.mock("../middleware/logger.js", () => ({ logger: mockLogger }));

import { __clearBundledPluginsCacheForTests, __listBundledPluginsForTests } from "../routes/plugins.js";

const SMOKE_PACKAGE_DIR = "packages/plugins/examples/plugin-authoring-smoke-example";
const SMOKE_PACKAGE_JSON = `${SMOKE_PACKAGE_DIR}/package.json`;
const SMOKE_MANIFEST_SOURCE = `${SMOKE_PACKAGE_DIR}/src/manifest.ts`;
const SMOKE_PACKAGE_NAME = "@paperclipai/plugin-authoring-smoke-example";
const SMOKE_DISPLAY_NAME = "Plugin Authoring Smoke Example";

type CatalogEntry = { packageName: string; displayName: string };

function packageNames(plugins: CatalogEntry[]): string[] {
  return plugins.map((plugin) => plugin.packageName);
}

function smokeEntry(plugins: CatalogEntry[]): CatalogEntry | undefined {
  return plugins.find((plugin) => plugin.packageName === SMOKE_PACKAGE_NAME);
}

function expectReadFailureWarning(code: string): void {
  expect(mockLogger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      readFailures: [expect.objectContaining({ error: expect.stringContaining(code) })],
    }),
    expect.any(String),
  );
}

describe("bundled plugin catalog", () => {
  afterEach(() => {
    fsControl.fault = null;
    __clearBundledPluginsCacheForTests();
    mockLogger.warn.mockClear();
  });

  it("does not cache a catalog built after a transient package.json read failure", async () => {
    fsControl.fault = { operation: "readFile", pathSuffix: SMOKE_PACKAGE_JSON, code: "EMFILE" };

    const degraded = await __listBundledPluginsForTests();
    expect(packageNames(degraded)).not.toContain(SMOKE_PACKAGE_NAME);
    expectReadFailureWarning("EMFILE");

    const recovered = await __listBundledPluginsForTests();
    expect(packageNames(recovered)).toContain(SMOKE_PACKAGE_NAME);
  }, 20_000);

  it("does not cache a catalog built after a transient directory read failure", async () => {
    fsControl.fault = { operation: "readdir", pathSuffix: SMOKE_PACKAGE_DIR, code: "EMFILE" };

    const degraded = await __listBundledPluginsForTests();
    expect(packageNames(degraded)).not.toContain(SMOKE_PACKAGE_NAME);
    expectReadFailureWarning("EMFILE");

    const recovered = await __listBundledPluginsForTests();
    expect(packageNames(recovered)).toContain(SMOKE_PACKAGE_NAME);
  }, 20_000);

  it("does not cache a catalog built after a transient manifest source read failure", async () => {
    fsControl.fault = { operation: "readFile", pathSuffix: SMOKE_MANIFEST_SOURCE, code: "EIO" };

    const degraded = await __listBundledPluginsForTests();
    expect(smokeEntry(degraded)?.displayName).not.toBe(SMOKE_DISPLAY_NAME);
    expectReadFailureWarning("EIO");

    const recovered = await __listBundledPluginsForTests();
    expect(smokeEntry(recovered)?.displayName).toBe(SMOKE_DISPLAY_NAME);
  }, 20_000);

  it("does not cache an empty catalog after a transient access failure on the plugin root", async () => {
    fsControl.fault = { operation: "access", pathSuffix: "packages/plugins", code: "EACCES" };

    const degraded = await __listBundledPluginsForTests();
    expect(degraded).toEqual([]);
    expectReadFailureWarning("EACCES");

    const recovered = await __listBundledPluginsForTests();
    expect(packageNames(recovered)).toContain(SMOKE_PACKAGE_NAME);
  }, 20_000);

  it("treats a missing manifest source as optional and keeps the catalog cached", async () => {
    fsControl.fault = { operation: "access", pathSuffix: SMOKE_MANIFEST_SOURCE, code: "ENOENT" };

    const first = await __listBundledPluginsForTests();
    expect(smokeEntry(first)?.displayName).not.toBe(SMOKE_DISPLAY_NAME);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    const second = await __listBundledPluginsForTests();
    expect(smokeEntry(second)?.displayName).not.toBe(SMOKE_DISPLAY_NAME);
  }, 20_000);

  it("caches a catalog built without read failures", async () => {
    const first = await __listBundledPluginsForTests();
    expect(packageNames(first)).toContain(SMOKE_PACKAGE_NAME);

    fsControl.fault = { operation: "readFile", pathSuffix: SMOKE_PACKAGE_JSON, code: "EMFILE" };
    const second = await __listBundledPluginsForTests();
    expect(packageNames(second)).toContain(SMOKE_PACKAGE_NAME);
    expect(fsControl.fault).not.toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  }, 20_000);
});

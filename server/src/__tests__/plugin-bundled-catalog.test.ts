import { afterEach, describe, expect, it, vi } from "vitest";

const fsControl = vi.hoisted(() => ({ failNextPackageJsonRead: null as string | null }));
const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      const target = String(args[0]).replaceAll("\\", "/");
      if (fsControl.failNextPackageJsonRead && target.endsWith(fsControl.failNextPackageJsonRead)) {
        fsControl.failNextPackageJsonRead = null;
        throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      }
      return actual.readFile(...args);
    }),
  };
});

vi.mock("../middleware/logger.js", () => ({ logger: mockLogger }));

import { __clearBundledPluginsCacheForTests, __listBundledPluginsForTests } from "../routes/plugins.js";

const SMOKE_PACKAGE_JSON = "packages/plugins/examples/plugin-authoring-smoke-example/package.json";
const SMOKE_PACKAGE_NAME = "@paperclipai/plugin-authoring-smoke-example";

function packageNames(plugins: Array<{ packageName: string }>): string[] {
  return plugins.map((plugin) => plugin.packageName);
}

describe("bundled plugin catalog", () => {
  afterEach(() => {
    fsControl.failNextPackageJsonRead = null;
    __clearBundledPluginsCacheForTests();
    mockLogger.warn.mockClear();
  });

  it("does not cache a catalog built after a transient package.json read failure", async () => {
    fsControl.failNextPackageJsonRead = SMOKE_PACKAGE_JSON;

    const degraded = await __listBundledPluginsForTests();
    expect(packageNames(degraded)).not.toContain(SMOKE_PACKAGE_NAME);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        readFailures: [expect.objectContaining({ error: "EMFILE: too many open files" })],
      }),
      expect.any(String),
    );

    const recovered = await __listBundledPluginsForTests();
    expect(packageNames(recovered)).toContain(SMOKE_PACKAGE_NAME);
  }, 20_000);

  it("caches a catalog built without read failures", async () => {
    const first = await __listBundledPluginsForTests();
    expect(packageNames(first)).toContain(SMOKE_PACKAGE_NAME);

    fsControl.failNextPackageJsonRead = SMOKE_PACKAGE_JSON;
    const second = await __listBundledPluginsForTests();
    expect(packageNames(second)).toContain(SMOKE_PACKAGE_NAME);
    expect(fsControl.failNextPackageJsonRead).toBe(SMOKE_PACKAGE_JSON);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  }, 20_000);
});

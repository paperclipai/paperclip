import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalAdapterPackage } from "../adapters/plugin-loader.js";

// Regression test for the Windows ESM import bug: loadExternalAdapterPackage /
// reloadExternalAdapter must import from a proper file:// URL. On Windows an
// absolute module path is a drive-letter path (C:\...\index.js); passing it
// straight to import() throws "Received protocol 'c:'". pathToFileURL fixes it,
// and this test exercises that path with a real absolute local-path package.

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeLocalAdapter(type: string): Promise<{ dir: string; packageName: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pc-adapter-"));
  tmpDirs.push(dir);
  const packageName = `test-${type}-adapter`;
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: packageName, version: "1.0.0", type: "module", main: "index.js", exports: { ".": "./index.js" } },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(dir, "index.js"),
    `export function createServerAdapter() {
  return {
    type: ${JSON.stringify(type)},
    async execute() { return { exitCode: 0, signal: null, timedOut: false }; },
    async testEnvironment() {
      return { adapterType: ${JSON.stringify(type)}, status: "pass", checks: [], testedAt: new Date().toISOString() };
    },
  };
}
`,
  );
  return { dir, packageName };
}

describe("loadExternalAdapterPackage (local path)", () => {
  it("loads an ESM adapter from an absolute local path via a file:// URL", async () => {
    const { dir, packageName } = await makeLocalAdapter("localpathfixture");
    // dir is an absolute path; on Windows this is a drive-letter path that would
    // crash import() without the pathToFileURL conversion this test guards.
    expect(path.isAbsolute(dir)).toBe(true);

    const mod = await loadExternalAdapterPackage(packageName, dir);

    expect(mod.type).toBe("localpathfixture");
    expect(typeof mod.execute).toBe("function");
    expect(typeof mod.testEnvironment).toBe("function");
  });
});

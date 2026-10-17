import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCapability, readRelease } from "../managed-database/main.js";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const describeLinux = process.platform === "linux" ? describe : describe.skip;

// The image runs the supervisor from this bundle, root-owned, because the app
// user owns /app. These tests prove the bundle behaves like the source tree.
describeLinux("managed database supervisor bundle", () => {
  let outDir: string;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-mdb-bundle-"));
    outDir = path.join(workDir, "paperclip-managed-database");
    await run(process.execPath, [path.join(repoRoot, "scripts", "build-managed-database-supervisor.mjs"), outDir], { cwd: repoRoot });
    // As in the Dockerfile: the release identity comes from the app tree.
    writeFileSync(path.join(outDir, "release.json"), `${JSON.stringify(await readRelease(), null, 2)}\n`);
  }, 120_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reports the same capability as the source tree, using only its own files", async () => {
    // Run from an unrelated directory so nothing resolves through the checkout.
    const { stdout } = await run(process.execPath, [path.join(outDir, "main.mjs"), "capability"], { cwd: workDir });
    expect(JSON.parse(stdout)).toEqual(await readCapability());
  }, 60_000);

  it("initializes a cluster with its bundled engine", async () => {
    const dataDir = path.join(workDir, "initdb");
    const engine = path.join(outDir, "engine");
    await run(path.join(engine, "bin", "initdb"), ["-D", dataDir, "-U", "probe", "--auth=trust", "--no-sync"], {
      cwd: workDir,
      env: { PATH: process.env.PATH, LD_LIBRARY_PATH: path.join(engine, "lib"), LANG: "C", LC_ALL: "C" },
    });
  }, 60_000);

  it("refuses a release identity that does not describe its migrations", async () => {
    const releaseFile = path.join(outDir, "release.json");
    const release = await readRelease();
    writeFileSync(releaseFile, JSON.stringify({ ...release, migrationsDigest: "0".repeat(64) }));
    try {
      await expect(run(process.execPath, [path.join(outDir, "main.mjs"), "release"], { cwd: workDir }))
        .rejects.toMatchObject({ stderr: expect.stringContaining("does not describe the bundled migrations") });
    } finally {
      writeFileSync(releaseFile, JSON.stringify(release));
    }
  }, 60_000);
});

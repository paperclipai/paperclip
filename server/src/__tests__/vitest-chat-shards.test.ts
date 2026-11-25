import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

it("runs every split chat integration suite exactly once through the real chat shard CLI", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pc-shards-")));
  try {
    const chatDir = path.join(root, "server/src/__tests__/chat-channels");
    mkdirSync(chatDir, { recursive: true });
    mkdirSync(path.join(root, "server/scripts"), { recursive: true });
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
    const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, ...(rootPkg.packageManager ? { packageManager: rootPkg.packageManager } : {}) }),
    );
    writeFileSync(path.join(root, "vitest.config.mjs"), `export default {
      test: { projects: [{ test: { name: "@paperclipai/server", root: ${JSON.stringify(path.join(root, "server"))},
        include: ["src/**/*.test.ts"], pool: "forks", maxWorkers: 1 } }] }
    };`);
    const trace = path.join(root, "executed.jsonl");
    const fixtures: Array<[string, string[]]> = [
      ["alpha.integration.test.ts", ["alpha-1", "alpha-2"]],
      ["beta.integration.test.ts", ["beta-1", "beta-2"]],
      ["gamma.integration.test.ts", ["gamma-1"]],
    ];
    for (const [fileName, cases] of fixtures) {
      writeFileSync(
        path.join(chatDir, fileName),
        `import { appendFileSync } from "node:fs";
        import { expect, it } from "vitest";
        for (const id of ${JSON.stringify(cases)}) {
          it(id, () => {
            expect(id).toBeTruthy();
            appendFileSync(${JSON.stringify(trace)}, JSON.stringify(id) + "\\n");
          });
        }
        it.skip("intentionally skipped", () => { throw new Error("must stay skipped"); });`,
      );
    }
    const run = (index: number, count: number) => spawnSync(process.execPath, [
      path.join(repoRoot, "scripts/run-vitest-stable.mjs"), "--mode", "general", "--group", "general-chat",
      "--shard-index", String(index), "--shard-count", String(count),
    ], {
      cwd: root,
      env: { ...process.env, CI: "true", PAPERCLIP_CI_PROFILE: "false", PAPERCLIP_TEST_POSTGRES_SHARED: "0" },
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const index of [0, 1]) {
      const result = run(index, 2);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    const executed = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(executed.sort()).toEqual(["alpha-1", "alpha-2", "beta-1", "beta-2", "gamma-1"]);

    // Trailing empty shards exit cleanly without launching Vitest unfiltered.
    const emptyShard = run(4, 5);
    expect(emptyShard.error, emptyShard.stderr).toBeUndefined();
    expect(emptyShard.status, emptyShard.stdout + emptyShard.stderr).toBe(0);
    expect(emptyShard.stdout).toContain("running 0 of 3 suites");

    // A real assertion failure must fail the wrapper.
    writeFileSync(
      path.join(chatDir, "alpha.integration.test.ts"),
      'import { it } from "vitest"; it("fails", () => { throw new Error("fixture failure"); });',
    );
    const failed = run(0, 1);
    expect(failed.error, failed.stderr).toBeUndefined();
    expect(failed.status).not.toBe(0);
    expect(failed.stdout + failed.stderr).toContain("fixture failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

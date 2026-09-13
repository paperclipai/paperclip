import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/runner-full-stack-e2e.yml"), "utf8");

for (const [job, next] of [["report", "publish_history"], ["publish_history", "pages"]]) {
  describe(`${job} trusted lock resolution`, () => {
    const block = workflow.slice(workflow.indexOf(`  ${job}:`), workflow.indexOf(`  ${next}:`));
    const resolution = block.match(/- name: Resolve trusted reporting lockfile without lifecycle scripts\n        run: \|\n((?:          .*\n|\n)+)/)?.[1]
      .split("\n").map((line) => line.slice(10)).join("\n");

    it("keeps trusted checkout and resolves its own lock before frozen installation", () => {
      expect(block).toContain("ref: ${{ github.sha }}");
      expect(block).not.toContain("needs.target_lock.outputs");
      expect(resolution).toBeTruthy();
      expect(block.indexOf("Resolve trusted reporting lockfile")).toBeLessThan(block.indexOf("- run: pnpm install --frozen-lockfile"));
      if (job === "publish_history") {
        expect(block.indexOf("- run: pnpm install --frozen-lockfile")).toBeLessThan(block.indexOf("Exchange GitHub OIDC"));
      }
    });

    it.each(["stale-lock", "manifest-change", "new-file", "resolve-failed", "empty-lock"])("handles %s without accepting unrelated checkout changes", (scenario) => {
      expect(resolution).toBeTruthy();
      const dir = mkdtempSync(path.join(os.tmpdir(), "trusted-report-lock-"));
      try {
        writeFileSync(path.join(dir, "pnpm-lock.yaml"), "stale\n");
        writeFileSync(path.join(dir, "package.json"), "{}\n");
        execFileSync("git", ["init", "--quiet"], { cwd: dir });
        execFileSync("git", ["add", "."], { cwd: dir });
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: dir });
        const bin = path.join(dir, ".git", "test-bin");
        mkdirSync(bin);
        writeFileSync(path.join(bin, "pnpm"), `#!/bin/bash
set -eu
if [ "$*" = 'install --ignore-scripts --no-frozen-lockfile --lockfile-only' ]; then
  case "$SCENARIO" in
    resolve-failed) exit 19 ;;
    manifest-change) echo changed > package.json ;;
    new-file) echo unexpected > unexpected.txt ;;
    empty-lock) : > pnpm-lock.yaml; exit 0 ;;
  esac
  echo resolved > pnpm-lock.yaml
elif [ "$*" = 'install --frozen-lockfile' ]; then
  test "$(cat pnpm-lock.yaml)" = resolved
  echo installed > .git/frozen-install-completed
else
  exit 20
fi
`, { mode: 0o700 });
        const result = spawnSync("bash", ["-c", `${resolution}\npnpm install --frozen-lockfile\n`], {
          cwd: dir, env: { ...process.env, SCENARIO: scenario, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
        });
        if (scenario === "stale-lock") {
          expect(result.status, result.stderr).toBe(0);
          expect(readFileSync(path.join(dir, ".git/frozen-install-completed"), "utf8")).toBe("installed\n");
        } else {
          expect(result.status).not.toBe(0);
          expect(() => readFileSync(path.join(dir, ".git/frozen-install-completed"))).toThrow();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

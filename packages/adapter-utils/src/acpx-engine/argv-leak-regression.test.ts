import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const scripts = [
  "skills/paperclip/scripts/argv-leak-regression.py",
  "skills/paperclip/scripts/test_paperclip_api_security.py",
];

describe("Paperclip API helper credential transport", () => {
  const linuxProc = process.platform === "linux" && existsSync("/proc/self/cmdline");

  it.skipIf(!linuxProc)("passes the RED/GREEN argv and curl injection checks", () => {
    for (const script of scripts) {
      const result = spawnSync("python3", [path.join(repoRoot, script)], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 90_000,
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
        },
      });
      if (result.error || result.status !== 0) {
        throw new Error(`${script} failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
      }
    }
  }, 120_000);
});

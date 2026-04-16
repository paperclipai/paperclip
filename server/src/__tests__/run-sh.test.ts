import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runScriptPath = path.join(repoRoot, "run.sh");
const tempRoots: string[] = [];

function writeExecutable(targetPath: string, contents: string) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, contents, "utf8");
  chmodSync(targetPath, 0o755);
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("run.sh", () => {
  it("kills local dev activity before starting the filtered dev runner", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-run-sh-"));
    tempRoots.push(tempRoot);

    const callLogPath = path.join(tempRoot, "calls.log");
    const tempRunScriptPath = path.join(tempRoot, "run.sh");

    writeExecutable(tempRunScriptPath, readFileSync(runScriptPath, "utf8"));
    writeExecutable(
      path.join(tempRoot, "scripts", "kill-dev.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'kill\\n' >> "$CALL_LOG"
`,
    );
    writeExecutable(
      path.join(tempRoot, "bin", "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm:%s\\n' "$*" >> "$CALL_LOG"
printf 'warn: fake server\\n'
`,
    );
    writeExecutable(
      path.join(tempRoot, "bin", "rg"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'rg:%s\\n' "$*" >> "$CALL_LOG"
cat >/dev/null
`,
    );

    execFileSync("bash", [tempRunScriptPath], {
      cwd: tempRoot,
      env: {
        ...process.env,
        CALL_LOG: callLogPath,
        PATH: `${path.join(tempRoot, "bin")}:${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    });

    const calls = readFileSync(callLogPath, "utf8").trim().split("\n");

    expect(calls[0]).toBe("kill");
    expect(calls.slice(1).sort()).toEqual([
      "pnpm:-s dev",
      "rg:-i error|warn|fatal|failed",
    ]);
  });
});

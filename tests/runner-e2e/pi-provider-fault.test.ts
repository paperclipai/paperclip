import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The Linux calibrations are CPU-bound: each inspect re-reads and re-hashes the
// pinned Node binary. Hosted CI passed in 10.3-14.5 s before the fixture stopped
// hashing a second Node, and the shared 4-core fleet runs this lane about 1.8x
// slower. 45 s keeps about 3x margin over that slow case. Vitest gets 5 s more
// so a slow Python run reports its own output instead of a Vitest timeout.
const PYTHON_SUITE_TIMEOUT_MS = 45_000;

it("calibrates the exact Pi fault helper with metadata negatives and native Linux pidfd", () => {
  // Linux exercises a real, title-changing, test-owned Node child. macOS runs
  // every metadata negative and explicitly skips that Linux-only process test.
  // Never inherit provider credentials or an ambient Python module path.
  const result = spawnSync("/usr/bin/python3", ["-B", fileURLToPath(new URL("./pi-provider-fault.test.py", import.meta.url))], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PYTHONDONTWRITEBYTECODE: "1" },
    cwd: dirname(fileURLToPath(import.meta.url)), timeout: PYTHON_SUITE_TIMEOUT_MS, killSignal: "SIGTERM", maxBuffer: 64 * 1024,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("Ran 21 tests");
  if (process.platform === "linux") expect(result.stderr).not.toContain("skipped");
  else expect(result.stderr).toContain("skipped=3");
  console.info(result.stderr.trim());
}, PYTHON_SUITE_TIMEOUT_MS + 5_000);

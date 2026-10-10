import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("calibrates the exact Pi fault helper with metadata negatives and native Linux pidfd", () => {
  // Linux exercises a real, title-changing, test-owned Node child. macOS runs
  // every metadata negative and explicitly skips that Linux-only process test.
  // Never inherit provider credentials or an ambient Python module path.
  const result = spawnSync("/usr/bin/python3", ["-B", fileURLToPath(new URL("./pi-provider-fault.test.py", import.meta.url))], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PYTHONDONTWRITEBYTECODE: "1" },
    cwd: dirname(fileURLToPath(import.meta.url)), timeout: 25_000, killSignal: "SIGTERM", maxBuffer: 64 * 1024,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("Ran 21 tests");
  if (process.platform === "linux") expect(result.stderr).not.toContain("skipped");
  else expect(result.stderr).toContain("skipped=3");
  console.info(result.stderr.trim());
}, 30_000);

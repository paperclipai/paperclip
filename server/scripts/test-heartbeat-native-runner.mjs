import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "executes and finalizes a productive heartbeat through the real native runner",
  "preserves a real native Board wait while successful liveness is pending",
  "holds a real semantic blocked result during recovery",
];
const temp = mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-runner-report-"));
const report = path.join(temp, "report.json");
try {
  const result = spawnSync(process.execPath, [
    path.join(serverRoot, "../node_modules/vitest/vitest.mjs"), "run",
    "src/__tests__/heartbeat-process-recovery.test.ts",
    "-t", "real native runner heartbeat recovery",
    "--reporter=default", "--reporter=json", `--outputFile.json=${report}`,
  ], { cwd: serverRoot, stdio: "inherit", timeout: 1_100_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Native heartbeat runner tests failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`);
  }
  const data = JSON.parse(readFileSync(report, "utf8"));
  const assertions = data.testResults.flatMap((suite) => suite.assertionResults);
  for (const name of required) {
    const matches = assertions.filter((test) => test.title === name);
    if (matches.length !== 1 || matches[0].status !== "passed") {
      throw new Error(`Required runner test did not pass exactly once: ${name} (${matches.map((test) => test.status).join(", ") || "missing"})`);
    }
  }
  console.log("All three required native heartbeat runner tests passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

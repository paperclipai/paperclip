import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

const run = promisify(execFile);

// Keep the dependency-free, actual-CLI acceptance suite usable on a retained
// volume while also exercising the same cases in the normal CI test lane.
it("passes the read-only recovery cutover CLI acceptance suite", async () => {
  await run(process.execPath, ["--test", fileURLToPath(new URL("../../../scripts/recovery-cutover.test.mjs", import.meta.url))], {
    timeout: 45_000,
    maxBuffer: 1024 * 1024,
  });
}, 60_000);

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./benchmark-skill-materialization.ts", import.meta.url));
const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
function run(args) {
  const result = spawnSync(process.execPath, ["--import", loader, script, ...args], {
    cwd: root, encoding: "utf8", timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  return result.stderr;
}

it("requires an explicit pre-extraction baseline instead of using the current HEAD", () => {
  expect(run([])).toContain("Supply --baseline-ref=<commit>");
}, 30_000);

it("explains when the selected baseline no longer contains the original functions", () => {
  expect(run(["--baseline-ref=HEAD"])).toContain("must contain the code from before native asset file extraction");
}, 30_000);

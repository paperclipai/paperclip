import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("offline Copilot probe cleans up every injected early failure", () => {
  execFileSync("python3", [fileURLToPath(new URL("./probe-copilot-acp.test.py", import.meta.url))], {
    encoding: "utf8", timeout: 15_000, stdio: "pipe",
  });
});

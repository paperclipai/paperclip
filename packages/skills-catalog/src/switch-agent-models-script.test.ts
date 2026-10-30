import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("switch-agent-models Python regressions", () => {
  it("passes the model routing and rollback regression suite", () => {
    execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_switch_models.py"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 60_000,
      stdio: "pipe",
    });
  });
});

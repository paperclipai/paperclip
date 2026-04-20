import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

describe("dev runner launch", () => {
  it("can be launched through the server workspace wrapper", async () => {
    const result = await execFileAsync(
      pnpmBin,
      ["--filter", "@paperclipai/server", "exec", "tsx", "../scripts/dev-runner.ts", "dev"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PAPERCLIP_DEV_RUNNER_SMOKE_EXIT: "1",
        },
      },
    );

    expect(result.stdout).toContain("[paperclip] dev runner smoke exit (paperclip-dev-once)");
    expect(result.stderr).toBe("");
  });
});

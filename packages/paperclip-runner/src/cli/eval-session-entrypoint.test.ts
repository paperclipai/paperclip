import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

it("runs the eval CLI parser through both canonical and symlinked paths", async () => {
  const cli = await realpath(fileURLToPath(new URL("./eval-session.ts", import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), "paperclip-eval-cli-entrypoint-"));
  try {
    const alias = join(root, "cli-alias");
    await symlink(dirname(cli), alias, "dir");
    for (const path of [cli, join(alias, "eval-session.ts")]) {
      // A skipped main guard silently exits zero. Rejecting the invalid option
      // proves actual CLI execution without loading credentials or a provider.
      await expect(execute(tsx, [path, "--unknown", "value"], { timeout: 15_000 }))
        .rejects.toMatchObject({ code: 1, stderr: "unknown argument: --unknown\n" });
    }
    const imported = await execute(tsx, ["--eval", `import(${JSON.stringify(cli)}).then(() => console.log("imported"))`], { timeout: 15_000 });
    expect(imported.stdout.trim()).toBe("imported");
    expect(imported.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

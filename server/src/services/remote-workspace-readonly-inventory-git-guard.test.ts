import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readonlyWorkspaceInventoryScript } from "./remote-workspace-readonly-inventory.js";

const exec = promisify(execFile);
const LIMITS = { PAPERCLIP_GIT_MIN_FREE_BYTES: "536870912", PAPERCLIP_GIT_MIN_FREE_INODES: "1024", PAPERCLIP_GIT_MAX_GROWTH_BYTES: "1073741824" };
const BELOW_FLOOR = "9223372036854775807";

describe.skipIf(process.platform === "win32")("full-disk read-only inventory under the sandbox Git storage guard", () => {
  let scratch: string;
  let workspace: string;
  let guardBin: string;
  beforeEach(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-workspace-readonly-guard-")));
    workspace = path.join(scratch, "workspace");
    guardBin = path.join(scratch, "bin");
    await fs.mkdir(workspace);
    await fs.mkdir(guardBin);
    const realGit = path.join((await exec("git", ["--exec-path"])).stdout.trim(), "git");
    await fs.writeFile(path.join(guardBin, "git"), [
      "#!/bin/sh",
      "if [ -z \"$PAPERCLIP_GIT_MIN_FREE_BYTES\" ] || [ -z \"$PAPERCLIP_GIT_MIN_FREE_INODES\" ] || [ -z \"$PAPERCLIP_GIT_MAX_GROWTH_BYTES\" ]; then",
      "  echo \"paperclip_git_storage_limit: Git's storage guard is unavailable or misconfigured; Git did not complete.\" >&2; exit 75",
      "fi",
      `if [ "$PAPERCLIP_GIT_MIN_FREE_BYTES" = "${BELOW_FLOOR}" ]; then`,
      "  for arg in \"$@\"; do case \"$arg\" in ls-files)",
      "    echo \"paperclip_git_storage_limit: The sandbox has too little free disk space or too few free inodes; Git did not start.\" >&2; exit 75;;",
      "  esac; done",
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const git = (...args: string[]) => exec(realGit, ["-C", workspace, ...args]);
    await git("init", "-q");
    await fs.writeFile(path.join(workspace, "package.json"), "{}\n");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    await git("add", "package.json", "saved.txt");
    await fs.mkdir(path.join(workspace, "node_modules"));
    await fs.writeFile(path.join(workspace, "node_modules", "dependency.js"), "generated\n");
  });
  afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  const inspect = (limits: Record<string, string>) => exec(process.execPath, ["-e", readonlyWorkspaceInventoryScript(), workspace], {
    timeout: 15_000, env: { PATH: `${guardBin}${path.delimiter}${process.env.PATH}`, ...limits },
  });

  it("inventories a Git workspace when the guard's limits come from the sandbox environment", async () => {
    const { stdout } = await inspect(LIMITS);
    const inventory = JSON.parse(stdout) as { entries: number; exclude: string[] };
    expect(inventory.exclude).toEqual([".paperclip-runtime", "node_modules"]);
    expect(inventory.entries).toBeGreaterThan(2);
  });

  it("names a guard that refuses Git below its free-space floor instead of calling the source unsafe", async () => {
    await expect(inspect({ ...LIMITS, PAPERCLIP_GIT_MIN_FREE_BYTES: BELOW_FLOOR }))
      .rejects.toMatchObject({ code: 1, stderr: "remote_workspace_readonly_capture_git_storage_limit" });
  });

  it("names a guard that cannot read its limits", async () => {
    await expect(inspect({}))
      .rejects.toMatchObject({ code: 1, stderr: "remote_workspace_readonly_capture_git_storage_guard_unavailable" });
  });
});

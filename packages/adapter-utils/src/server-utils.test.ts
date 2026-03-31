import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCommandForLogs } from "./server-utils.js";

const itWindows = process.platform === "win32" ? it : it.skip;
const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const target = cleanups.pop();
    if (!target) continue;
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
});

describe("resolveCommandForLogs", () => {
  itWindows("prefers PATHEXT command shims over bare npm shell shims on Windows", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-command-resolution-"));
    cleanups.push(tempDir);

    const bareShimPath = path.join(tempDir, "opencode");
    const cmdShimPath = path.join(tempDir, "opencode.cmd");

    await fs.writeFile(
      bareShimPath,
      "#!/bin/sh\nexit 1\n",
      "utf8",
    );
    await fs.writeFile(
      cmdShimPath,
      "@ECHO off\r\nEXIT /b 0\r\n",
      "utf8",
    );

    const resolved = await resolveCommandForLogs("opencode", tempDir, {
      ...process.env,
      PATH: tempDir,
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
    });

    expect(path.normalize(resolved)).toBe(path.normalize(cmdShimPath));
  });
});

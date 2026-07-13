import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapIdleBrowserSessions } from "./browser-session-reaper.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed browser idle reaper", () => {
  it("closes an issue session after one hour without a browser command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-browser-reaper-"));
    tempRoots.push(root);
    const socketDir = path.join(root, "pab");
    const activityDir = path.join(socketDir, ".paperclip-browser-activity");
    await fs.mkdir(activityDir, { recursive: true });
    const session = "pc-idle123";
    await fs.writeFile(path.join(socketDir, `${session}.pid`), String(process.pid));
    const activityPath = path.join(activityDir, `${session}.activity`);
    await fs.writeFile(activityPath, "");
    await fs.utimes(activityPath, new Date(0), new Date(0));
    const callsPath = path.join(root, "calls");
    const fakeBrowser = path.join(root, "agent-browser-real");
    await fs.writeFile(fakeBrowser, `#!/bin/sh\nprintf '%s %s\\n' "$AGENT_BROWSER_SESSION" "$1" >> '${callsPath}'\n`);
    await fs.chmod(fakeBrowser, 0o755);

    const result = await reapIdleBrowserSessions({
      socketDir,
      realAgentBrowser: fakeBrowser,
      idleTimeoutSeconds: 3600,
      now: () => 3_600_001,
    });

    expect(result).toEqual({ reaped: 1 });
    expect(await fs.readFile(callsPath, "utf8")).toBe(`${session} close\n`);
    await expect(fs.stat(activityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a recently active issue session alive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-browser-reaper-"));
    tempRoots.push(root);
    const socketDir = path.join(root, "pab");
    const activityDir = path.join(socketDir, ".paperclip-browser-activity");
    await fs.mkdir(activityDir, { recursive: true });
    const session = "pc-active123";
    await fs.writeFile(path.join(socketDir, `${session}.pid`), String(process.pid));
    await fs.writeFile(path.join(activityDir, `${session}.activity`), "");

    const result = await reapIdleBrowserSessions({ socketDir, idleTimeoutSeconds: 3600 });

    expect(result).toEqual({ reaped: 0 });
  });
});

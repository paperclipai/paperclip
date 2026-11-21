import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLocalAdapterTestProbeEnv } from "./probe-env.js";

const tempDirs: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

async function makeTrustedDirWithClaudeCmd(): Promise<{ dir: string; claudePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-env-win-"));
  tempDirs.push(dir);
  const claudePath = path.join(dir, "claude.CMD");
  await writeFile(claudePath, "@echo off\r\n");
  return { dir, claudePath };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("buildLocalAdapterTestProbeEnv on Windows", () => {
  it("resolves claude from a trusted lowercase path key", async () => {
    const { dir, claudePath } = await makeTrustedDirWithClaudeCmd();
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: {},
      trustedEnv: { path: dir, PATHEXT: ".CMD" },
    });
    expect(built.command).toBe(claudePath);
  });

  it("still resolves claude from a trusted Path key", async () => {
    const { dir, claudePath } = await makeTrustedDirWithClaudeCmd();
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: {},
      trustedEnv: { Path: dir, PATHEXT: ".CMD" },
    });
    expect(built.command).toBe(claudePath);
  });
});

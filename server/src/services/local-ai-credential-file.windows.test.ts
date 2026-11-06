import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string | undefined;
function usePlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platform, value });
}
async function credentialHome() {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-read-"));
  const home = path.join(root, "private");
  await mkdir(home, { mode: 0o700 });
  return home;
}
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  if (root) await rm(root, { force: true, recursive: true });
  root = undefined;
});

describe("isolated subscription credential read", () => {
  it("accepts a regular private Windows credential file without POSIX uid/mode assertions", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "test credential", { mode: 0o600 });
    await chmod(file, 0o644); // Windows file modes cannot be used for this check.
    usePlatform("win32");
    expect(await readLocalAiCredentialFile(file)).toBe("test credential");
  });

  it.skipIf(process.platform === "win32")("rejects a Windows credential symlink", async () => {
    const home = await credentialHome();
    const target = path.join(root!, "elsewhere");
    await writeFile(target, "not a credential");
    const link = path.join(home, ".credentials.json");
    await symlink(target, link);
    usePlatform("win32");
    await expect(readLocalAiCredentialFile(link)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked Windows login directory", async () => {
    const home = await credentialHome();
    const link = path.join(root!, "redirect");
    await symlink(home, link, "dir");
    await writeFile(path.join(home, ".credentials.json"), "not valid");
    usePlatform("win32");
    await expect(readLocalAiCredentialFile(path.join(link, ".credentials.json"))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("rejects a Windows login directory junction", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "not valid");
    const junction = path.join(root!, "redirect-junction");
    await symlink(home, junction, "junction");

    await expect(readLocalAiCredentialFile(path.join(junction, ".credentials.json"))).rejects.toThrow();
  });

  it("rejects oversized Windows credentials", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "x".repeat(64 * 1024 + 1));
    usePlatform("win32");
    await expect(readLocalAiCredentialFile(file)).rejects.toThrow("Invalid credential file");
  });

  it.skipIf(process.platform === "win32")("keeps the original POSIX owner/mode policy", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "private", { mode: 0o600 });
    expect(await readLocalAiCredentialFile(file)).toBe("private");
    await chmod(file, 0o644);
    await expect(readLocalAiCredentialFile(file)).rejects.toThrow();
  });
});

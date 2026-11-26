import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";

const initialPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let dir: string | undefined;
afterEach(async () => {
  Object.defineProperty(process, "platform", initialPlatform);
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readLocalAiCredentialFile on native Windows", () => {
  it("reads a credential file even though Windows has no uid or 0600 mode", async () => {
    if (initialPlatform.value !== "win32") return;
    dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cred-"));
    const file = path.join(dir, ".credentials.json");
    await writeFile(file, '{"claudeAiOauth":{"accessToken":"t"}}');
    await expect(readLocalAiCredentialFile(file)).resolves.toContain("accessToken");
  });

  it("refuses a symlinked credential file", async () => {
    if (initialPlatform.value !== "win32") return;
    dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cred-"));
    const target = path.join(dir, "real.json");
    const link = path.join(dir, "link.json");
    await writeFile(target, "{}");
    try { await symlink(target, link); } catch { return; }
    await expect(readLocalAiCredentialFile(link)).rejects.toThrow();
  });

  it("refuses a credential file reached through a junction directory", async () => {
    if (initialPlatform.value !== "win32") return;
    dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cred-"));
    const real = path.join(dir, "real");
    const junction = path.join(dir, "junction");
    await mkdir(real);
    await writeFile(path.join(real, ".credentials.json"), "{}");
    try { await symlink(real, junction, "junction"); } catch { return; }
    await expect(readLocalAiCredentialFile(path.join(junction, ".credentials.json"))).rejects.toThrow("Invalid credential file");
  });
});

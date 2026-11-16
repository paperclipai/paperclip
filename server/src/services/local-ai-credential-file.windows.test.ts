import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile, link, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";
import { createNativeCredentialStore } from "./native-runtime/native-credential-store.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let root: string | undefined;
async function credentialHome() {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-read-"));
  const home = path.join(root, "private");
  await mkdir(home);
  await writeFile(path.join(home, ".credentials.json"), "owned credential", { mode: 0o600 });
  return home;
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { force: true, recursive: true });
  root = undefined;
});

describe.skipIf(process.platform !== "win32")("native Windows subscription credential read", () => {
  it("reads a regular credential without POSIX uid or mode assumptions", async () => {
    const home = await credentialHome();
    expect(await readLocalAiCredentialFile(path.join(home, ".credentials.json"))).toBe("owned credential");
  });
  it("preserves ENOENT for a missing file in a checked directory", async () => {
    const home = await credentialHome();
    await expect(readLocalAiCredentialFile(path.join(home, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["codex", "grok"] as const)("reads the saved %s refresh handoff only when auth.json is absent", async provider => {
    const home = await credentialHome();
    const store = createNativeCredentialStore({ provider, localHome: home });
    await writeFile(path.join(home, "auth-refresh.json"), "saved refresh credential");
    expect(await store.read()).toBe("saved refresh credential");
    await link(path.join(home, ".credentials.json"), path.join(home, "auth.json"));
    await expect(store.read()).rejects.toThrow("Invalid Windows credential file");
  });
  it("rejects a junction at the login directory", async () => {
    const home = await credentialHome(), junction = path.join(root!, "junction");
    await symlink(home, junction, "junction");
    await expect(readLocalAiCredentialFile(path.join(junction, ".credentials.json"))).rejects.toThrow();
  });
  it("rejects a junction in an earlier ancestor", async () => {
    const home = await credentialHome(), junction = path.join(root!, "junction");
    await symlink(root!, junction, "junction");
    await expect(readLocalAiCredentialFile(path.join(junction, "private", ".credentials.json"))).rejects.toThrow();
  });
  it("does not disclose another credential when a junction replaces a checked parent", async () => {
    const home = await credentialHome(), filename = path.join(home, ".credentials.json");
    const outside = path.join(root!, "other-account");
    await mkdir(outside);
    await writeFile(path.join(outside, ".credentials.json"), "foreign credential");
    const originalLstat = fs.lstat;
    let swapped!: () => void;
    const swapFinished = new Promise<void>(resolve => { swapped = resolve; });
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === home) {
        const checked = await originalLstat(...args);
        await rename(home, home + "-original");
        await symlink(outside, home, "junction");
        swapped();
        return checked;
      }
      if (args[0] === filename) await swapFinished;
      return originalLstat(...args);
    });
    const result = await readLocalAiCredentialFile(filename).catch(() => undefined);
    expect(result === "owned credential" || result === undefined).toBe(true);
  });
  it("rejects hard-linked credentials", async () => {
    const home = await credentialHome(), filename = path.join(home, ".credentials.json");
    await link(filename, path.join(root!, "alias"));
    await expect(readLocalAiCredentialFile(filename)).rejects.toThrow();
  });
  it("does not follow a junction swapped concurrently with the native read", async () => {
    const home = await credentialHome(), filename = path.join(home, ".credentials.json");
    const outside = path.join(root!, "other-account"), original = home + "-original";
    await mkdir(outside);
    await writeFile(path.join(outside, ".credentials.json"), "foreign credential");
    let finished = false, swaps = 0;
    const mutate = (async () => {
      while (!finished) {
        try { await rename(home, original); }
        catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await delay(1);
          continue;
        }
        try {
          await symlink(outside, home, "junction");
          swaps++;
          await delay(1);
        } finally {
          await unlink(home).catch(error => { if (error.code !== "ENOENT") throw error; });
          await rename(original, home);
        }
      }
    })();
    let result: string | undefined;
    try { result = await readLocalAiCredentialFile(filename).catch(() => undefined); }
    finally { finished = true; await mutate; }
    expect(swaps).toBeGreaterThan(0);
    expect(result === "owned credential" || result === undefined).toBe(true);
  }, 20_000);
  it("rejects oversized credentials and directories", async () => {
    const home = await credentialHome(), filename = path.join(home, ".credentials.json");
    await writeFile(filename, "x".repeat(64 * 1024 + 1));
    await expect(readLocalAiCredentialFile(filename)).rejects.toThrow();
    await expect(readLocalAiCredentialFile(home)).rejects.toThrow();
  });
});

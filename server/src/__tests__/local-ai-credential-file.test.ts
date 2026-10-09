import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLocalAiCredentialFile } from "../services/local-ai-credential-file.js";
let home: string;
beforeEach(async () => { home = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-auth-read-"))); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
describe("isolated credential file safety", () => {
  it("reads only bounded private regular files", async () => {
    const filename = path.join(home, "credentials.json");
    await writeFile(filename, "fixture", { mode: 0o600 });
    await expect(readLocalAiCredentialFile(filename)).resolves.toBe("fixture");
    await chmod(filename, 0o644);
    await expect(readLocalAiCredentialFile(filename)).rejects.toThrow();
    await chmod(filename, 0o600);
    await writeFile(filename, Buffer.alloc(64 * 1024 + 1));
    await expect(readLocalAiCredentialFile(filename)).rejects.toThrow();
    await expect(readLocalAiCredentialFile(home)).rejects.toThrow();
  });
  it("rejects file and ancestor symlinks", async () => {
    const filename = path.join(home, "credentials.json");
    await writeFile(filename, "fixture", { mode: 0o600 });
    await symlink(filename, path.join(home, "linked.json"));
    await expect(readLocalAiCredentialFile(path.join(home, "linked.json"))).rejects.toThrow();
    await symlink(home, path.join(home, "linked-home"));
    await expect(readLocalAiCredentialFile(path.join(home, "linked-home", "credentials.json"))).rejects.toThrow();
  });
});

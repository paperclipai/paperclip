import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexHome, resolveManagedCodexHomeDir } from "./codex-home.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeCodexEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-test-"));
  cleanupPaths.add(root);

  const sourceHome = path.join(root, "shared-codex");
  const paperclipHome = path.join(root, "paperclip-home");
  await fs.mkdir(sourceHome, { recursive: true });
  await fs.writeFile(
    path.join(sourceHome, "auth.json"),
    JSON.stringify({ user: "windows-test@example.com" }, null, 2),
    "utf8",
  );

  return {
    env: {
      CODEX_HOME: sourceHome,
      PAPERCLIP_HOME: paperclipHome,
    } satisfies NodeJS.ProcessEnv,
    sourceHome,
  };
}

describe("prepareManagedCodexHome", () => {
  it("copies auth.json when symlink creation is not permitted", async () => {
    const { env, sourceHome } = await makeCodexEnv();
    const companyId = "company-123";
    const logs: string[] = [];
    const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    vi.spyOn(fs, "symlink").mockRejectedValueOnce(eperm);

    const targetHome = await prepareManagedCodexHome(env, async (_stream, chunk) => {
      logs.push(chunk);
    }, companyId);

    expect(targetHome).toBe(resolveManagedCodexHomeDir(env, companyId));
    const targetAuthPath = path.join(targetHome, "auth.json");
    await expect(fs.readFile(targetAuthPath, "utf8")).resolves.toBe(
      await fs.readFile(path.join(sourceHome, "auth.json"), "utf8"),
    );
    expect((await fs.lstat(targetAuthPath)).isSymbolicLink()).toBe(false);
    expect(logs.join("")).toContain("Seeded Codex shared file \"auth.json\" by copy");
  });
});

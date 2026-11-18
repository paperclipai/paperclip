import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

async function findFiles(dir: string, name: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findFiles(full, name)));
    else if (entry.name === name) out.push(full);
  }
  return out;
}

describe("codex_local testEnvironment managed home", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips adapter-config managed roots from the local probe subprocess", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-envtest-roots-"));
    const serverHome = path.join(root, "server-paperclip");
    const sharedCodexHome = path.join(root, ".codex");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(root, "codex");
    const observed = path.join(root, "observed-roots.txt");
    try {
      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$PAPERCLIP_HOME" "$PAPERCLIP_INSTANCE_ID" > "${observed}"\nexit 1\n`, { mode: 0o755 });
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("CODEX_HOME", sharedCodexHome);
      vi.stubEnv("PAPERCLIP_HOME", serverHome);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
      await testEnvironment({
        companyId: "company-1", adapterType: "codex_local",
        config: {
          command: fakeCodex, cwd, engine: "cli",
          env: { OPENAI_API_KEY: "", PAPERCLIP_HOME: path.join(root, "redirected"), PAPERCLIP_INSTANCE_ID: "redirected" },
        },
      });
      expect(await fs.readFile(observed, "utf8")).toBe("\n\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores adapter-config PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID when seeding the managed Codex home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-envtest-home-"));
    const serverHome = path.join(root, "server-paperclip");
    const redirectedHome = path.join(root, "config-paperclip");
    const sharedCodexHome = path.join(root, ".codex");
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(binDir, "codex");

    try {
      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeCodex, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("CODEX_HOME", sharedCodexHome);
      vi.stubEnv("PAPERCLIP_HOME", serverHome);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");

      await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: fakeCodex,
          cwd,
          engine: "cli",
          env: {
            PAPERCLIP_HOME: redirectedHome,
            PAPERCLIP_INSTANCE_ID: "redirected",
            OPENAI_API_KEY: "config-key-for-test",
          },
        },
      });

      await expect(fs.stat(redirectedHome)).rejects.toMatchObject({ code: "ENOENT" });
      const seeded = await findFiles(serverHome, "auth.json");
      expect(seeded).toHaveLength(1);
      expect(seeded[0]).toContain(path.join("companies", "company-1", "codex-home"));
      expect(JSON.parse(await fs.readFile(seeded[0]!, "utf8"))).toMatchObject({
        auth_mode: "apikey",
        OPENAI_API_KEY: "config-key-for-test",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("does not seed the host OPENAI_API_KEY when adapter config sets OPENAI_API_KEY to empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-envtest-emptykey-"));
    const serverHome = path.join(root, "server-paperclip");
    const sharedCodexHome = path.join(root, ".codex");
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(binDir, "codex");

    try {
      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeCodex, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      vi.stubEnv("OPENAI_API_KEY", "host-key-must-not-be-seeded");
      vi.stubEnv("CODEX_HOME", sharedCodexHome);
      vi.stubEnv("PAPERCLIP_HOME", serverHome);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");

      await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: fakeCodex,
          cwd,
          engine: "cli",
          env: { OPENAI_API_KEY: "" },
        },
      });

      const seeded = await findFiles(serverHome, "auth.json");
      for (const file of seeded) {
        const raw = await fs.readFile(file, "utf8").catch(() => "");
        expect(raw).not.toContain("host-key-must-not-be-seeded");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

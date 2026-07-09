import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

describe("codex managed-home auth fail-fast", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("fails fast when a managed CODEX_HOME has no auth.json and OPENAI_API_KEY is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-failfast-"));
    cleanupDirs.push(root);

    const paperclipHome = path.join(root, "paperclip-home");
    const emptySharedHome = path.join(root, "shared-codex-home");
    const workspaceDir = path.join(root, "workspace");
    // A managed per-agent home with no credentials seeded into it.
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    await fs.mkdir(emptySharedHome, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    // Source home has no auth.json, so nothing is symlinked into the managed home.
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", emptySharedHome);

    await expect(
      execute({
        runId: "run-failfast",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: "codex",
          cwd: workspaceDir,
          env: {
            CODEX_HOME: managedAgentHome,
            OPENAI_API_KEY: "",
          },
        },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow(/no Codex credentials provisioned for managed home/);

    // The managed home must not have been left with a usable auth.json.
    await expect(fs.access(path.join(managedAgentHome, "auth.json"))).rejects.toBeTruthy();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "./types.js";

type RunOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
};

type MetaSummary = {
  cwd?: string;
  commandArgs?: string[];
};

export function defineLocalAdapterExecuteContract(input: {
  label: string;
  execute: (ctx: AdapterExecutionContext) => Promise<unknown>;
  buildContext: (overrides?: Partial<AdapterExecutionContext>) => AdapterExecutionContext;
  defaultConfig: Record<string, unknown>;
  configuredCwdConfig: (configuredCwd: string) => Record<string, unknown>;
  prepareMocks: (args: { tempDir: string }) => Promise<void> | void;
  getRunOptions: () => RunOptions;
  getMeta?: (onMeta: ReturnType<typeof vi.fn>) => MetaSummary | undefined;
}) {
  describe(`${input.label} execute contract`, () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-${input.label}-execute-`));
      await input.prepareMocks({ tempDir });
    });

    afterEach(async () => {
      vi.clearAllMocks();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("passes project workspace metadata env fields", async () => {
      const cwd = path.join(tempDir, "project");
      await fs.mkdir(cwd, { recursive: true });
      const onMeta = vi.fn(async () => {});

      await input.execute(
        input.buildContext({
          config: input.defaultConfig,
          context: {
            issueId: "issue-123",
            paperclipWorkspace: {
              cwd,
              source: "project_primary",
              strategy: "git_worktree",
              workspaceId: "workspace-123",
              repoUrl: "https://github.com/acme/repo.git",
              repoRef: "main",
              branchName: "issue-123-fix",
              worktreePath: "/tmp/worktree-path",
            },
            paperclipWorkspaces: [{ workspaceId: "workspace-123", cwd }],
            paperclipRuntimeServiceIntents: [{ serviceName: "devserver" }],
            paperclipRuntimeServices: [{ serviceName: "devserver", url: "http://127.0.0.1:4173" }],
            paperclipRuntimePrimaryUrl: "http://127.0.0.1:4173",
          },
          onMeta,
        }),
      );

      const runOpts = input.getRunOptions();
      expect(runOpts.cwd).toBe(cwd);
      expect(runOpts.env.PAPERCLIP_WORKSPACE_CWD).toBe(cwd);
      expect(runOpts.env.PAPERCLIP_WORKSPACE_SOURCE).toBe("project_primary");
      expect(runOpts.env.PAPERCLIP_WORKSPACE_STRATEGY).toBe("git_worktree");
      expect(runOpts.env.PAPERCLIP_WORKSPACE_ID).toBe("workspace-123");
      expect(runOpts.env.PAPERCLIP_WORKSPACE_REPO_URL).toBe("https://github.com/acme/repo.git");
      expect(runOpts.env.PAPERCLIP_WORKSPACE_REPO_REF).toBe("main");
      expect(runOpts.env.PAPERCLIP_WORKSPACE_BRANCH).toBe("issue-123-fix");
      expect(runOpts.env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBe("/tmp/worktree-path");
      expect(runOpts.env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON).toBe(
        JSON.stringify([{ serviceName: "devserver" }]),
      );
      expect(runOpts.env.PAPERCLIP_RUNTIME_SERVICES_JSON).toBe(
        JSON.stringify([{ serviceName: "devserver", url: "http://127.0.0.1:4173" }]),
      );
      expect(runOpts.env.PAPERCLIP_RUNTIME_PRIMARY_URL).toBe("http://127.0.0.1:4173");

      const meta = input.getMeta?.(onMeta);
      if (meta) {
        expect(meta.cwd).toBe(cwd);
      }
    });

    it("uses configured cwd instead of agent_home fallback without exporting fallback workspace cwd", async () => {
      const configuredCwd = path.join(tempDir, "configured-workspace");
      await fs.mkdir(configuredCwd, { recursive: true });

      await input.execute(
        input.buildContext({
          config: input.configuredCwdConfig(configuredCwd),
          context: {
            paperclipWorkspace: {
              cwd: "/Users/example/.paperclip/instances/default/workspaces/agent-123",
              source: "agent_home",
            },
          },
        }),
      );

      const runOpts = input.getRunOptions();
      expect(runOpts.cwd).toBe(configuredCwd);
      expect(runOpts.env.PAPERCLIP_WORKSPACE_SOURCE).toBe("agent_home");
      expect(runOpts.env.PAPERCLIP_WORKSPACE_CWD).toBeUndefined();
    });
  });
}

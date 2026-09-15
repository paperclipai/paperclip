import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execute as claude } from "@paperclipai/adapter-claude-local/server";
import { execute as opencode } from "@paperclipai/adapter-opencode-local/server";
import { execute as pi } from "@paperclipai/adapter-pi-local/server";

describe("legacy sandbox workspace ownership", () => {
  it.each([["claude_local", claude], ["opencode_local", opencode], ["pi_local", pi]] as const)(
    "%s leaves sandbox paths to the remote runner",
    async (adapterType, execute) => {
      const root = await mkdtemp(join(tmpdir(), "remote-work-folder-"));
      const hostSentinel = join(root, "host-file");
      await writeFile(hostSentinel, "host-owned");
      // This sandbox path cannot be mkdir'd on the app host. Reaching the
      // remote command probe proves startup did not claim the path locally.
      const cwd = join(hostSentinel, "repos", "project");
      const probe = vi.fn(async () => { throw new Error("remote-probe-reached"); });
      try {
        await expect(execute({
          runId: "remote-work-folder-run",
          agent: { id: "agent", companyId: "company", name: "test", adapterType, adapterConfig: {} },
          config: { engine: "cli", cwd, command: "qualified-provider", env: {} },
          context: { paperclipWorkspace: { cwd } },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          executionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona",
            remoteCwd: cwd, workFolderHome: root, runner: { execute: probe } },
          onLog: async () => {},
        })).rejects.toThrow("remote-probe-reached");
        expect(probe).toHaveBeenCalled();
        expect(await readFile(hostSentinel, "utf8")).toBe("host-owned");
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
});

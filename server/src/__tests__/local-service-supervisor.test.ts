import { describe, expect, it } from "vitest";
import {
  cleanupOrphanedPaperclipRuntimeProcesses,
  selectOrphanedPaperclipRuntimeProcesses,
  type LocalProcessSnapshot,
} from "../services/local-service-supervisor.ts";

function proc(partial: Partial<LocalProcessSnapshot> & { pid: number }): LocalProcessSnapshot {
  return {
    parentPid: null,
    processGroupId: null,
    commandName: "node",
    commandLine: "node server/src/index.ts",
    cwd: null,
    ...partial,
  };
}

describe("local service stale runtime cleanup", () => {
  it("detects unregistered Paperclip-marked dev processes contained by a workspace root", () => {
    const root = "/tmp/paperclip-worktree/PAP-11663-cleanup";
    const candidates = selectOrphanedPaperclipRuntimeProcesses({
      containmentRoots: [root],
      currentProcessId: 1,
      currentProcessGroupId: 10,
      processes: [
        proc({
          pid: 1200,
          processGroupId: 2200,
          commandName: "pnpm",
          commandLine: "pnpm dev",
          cwd: root,
          paperclipRuntimeMarkers: {
            PAPERCLIP_MANAGED_RUNTIME: "workspace-runtime",
          },
        }),
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      pid: 1200,
      processGroupId: 2200,
      matchedRoot: root,
      containmentEvidence: "cwd",
      ownershipEvidence: "paperclip_runtime_env",
    });
  });

  it("accepts command-line containment only for path tokens under the root", () => {
    const root = "/tmp/paperclip";
    const candidates = selectOrphanedPaperclipRuntimeProcesses({
      containmentRoots: [root],
      currentProcessId: 1,
      currentProcessGroupId: 10,
      processes: [
        proc({
          pid: 1200,
          processGroupId: 2200,
          commandLine: `node ${root}/server/src/index.ts`,
          cwd: null,
        }),
        proc({
          pid: 1201,
          processGroupId: 2201,
          commandName: "vite",
          commandLine: `vite --root=${root}/apps/board --host 127.0.0.1`,
          cwd: null,
          paperclipRuntimeMarkers: {
            PAPERCLIP_MANAGED_RUNTIME: "workspace-runtime",
          },
        }),
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.containmentEvidence)).toEqual(["command", "command"]);
    expect(candidates.map((candidate) => candidate.ownershipEvidence)).toEqual([
      "paperclip_entrypoint",
      "paperclip_runtime_env",
    ]);
  });

  it("ignores processes without containment, non-node dev intent, managed pids, and the current process group", () => {
    const root = "/tmp/paperclip-worktree/PAP-11663-cleanup";
    const candidates = selectOrphanedPaperclipRuntimeProcesses({
      containmentRoots: [root],
      managedProcessIds: [1400, 2400],
      currentProcessId: 1,
      currentProcessGroupId: 99,
      processes: [
        proc({
          pid: 1200,
          processGroupId: 2200,
          commandLine: "node /tmp/other/server/src/index.ts",
          cwd: "/tmp/other",
        }),
        proc({
          pid: 1300,
          processGroupId: 2300,
          commandName: "python",
          commandLine: "python -m http.server",
          cwd: root,
          paperclipRuntimeMarkers: {
            PAPERCLIP_MANAGED_RUNTIME: "workspace-runtime",
          },
        }),
        proc({
          pid: 1400,
          processGroupId: 2400,
          commandLine: `node ${root}/server/src/index.ts`,
          cwd: root,
        }),
        proc({
          pid: 1500,
          processGroupId: 99,
          commandLine: `node ${root}/server/src/index.ts`,
          cwd: root,
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("does not select unrelated nested package dev processes under known roots", () => {
    const root = "/tmp/paperclip-worktree/PAP-11663-cleanup";
    const candidates = selectOrphanedPaperclipRuntimeProcesses({
      containmentRoots: [root],
      currentProcessId: 1,
      currentProcessGroupId: 10,
      processes: [
        proc({
          pid: 1200,
          processGroupId: 2200,
          commandName: "pnpm",
          commandLine: "pnpm dev",
          cwd: `${root}/unrelated-app`,
        }),
        proc({
          pid: 1201,
          processGroupId: 2201,
          commandName: "node",
          commandLine: `node ${root}/unrelated-app/node_modules/vite/bin/vite.js --host 127.0.0.1`,
          cwd: `${root}/unrelated-app`,
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("does not treat sibling path prefixes as command-line containment", () => {
    const candidates = selectOrphanedPaperclipRuntimeProcesses({
      containmentRoots: ["/tmp/paperclip"],
      currentProcessId: 1,
      currentProcessGroupId: 10,
      processes: [
        proc({
          pid: 1234,
          parentPid: null,
          processGroupId: 2222,
          commandName: "node",
          commandLine: "node /tmp/paperclip-evil/server/src/index.ts",
          cwd: "/tmp/elsewhere",
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("does not classify one-shot build tooling as stale runtime servers", () => {
    const root = "/tmp/paperclip-worktree/PAP-11663-cleanup";
    const candidates = selectOrphanedPaperclipRuntimeProcesses({
      containmentRoots: [root],
      currentProcessId: 1,
      currentProcessGroupId: 10,
      processes: [
        proc({
          pid: 1200,
          processGroupId: 2200,
          commandName: "node",
          commandLine: `node ${root}/node_modules/vite/bin/vite.js build`,
          cwd: root,
        }),
        proc({
          pid: 1201,
          processGroupId: 2201,
          commandName: "esbuild",
          commandLine: `esbuild ${root}/src/index.ts --bundle --outfile=${root}/dist/index.js`,
          cwd: root,
        }),
        proc({
          pid: 1202,
          processGroupId: 2202,
          commandName: "tsx",
          commandLine: `tsx ${root}/scripts/one-shot-maintenance.ts`,
          cwd: root,
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("honors registry metadata child pids as managed runtime processes", async () => {
    const root = "/tmp/paperclip-worktree/PAP-11663-cleanup";
    const result = await cleanupOrphanedPaperclipRuntimeProcesses({
      containmentRoots: [root],
      currentProcessId: 1,
      currentProcessGroupId: 10,
      registryRecords: [
        {
          version: 1,
          serviceKey: "paperclip-dev-watch",
          profileKind: "paperclip-dev",
          serviceName: "paperclip-dev-watch",
          command: "dev-runner.ts",
          cwd: root,
          envFingerprint: "fingerprint",
          port: 3100,
          url: "http://127.0.0.1:3100",
          pid: 1200,
          processGroupId: null,
          provider: "local_process",
          runtimeServiceId: null,
          reuseKey: null,
          startedAt: new Date(0).toISOString(),
          lastSeenAt: new Date(0).toISOString(),
          metadata: {
            childPid: 1201,
          },
        },
      ],
      processSnapshots: [
        proc({
          pid: 1201,
          processGroupId: 2200,
          commandLine: `node ${root}/server/src/index.ts`,
          cwd: root,
        }),
      ],
      terminate: async () => {
        throw new Error("managed child pid should not be terminated");
      },
    });

    expect(result).toMatchObject({
      scanned: 1,
      matched: 0,
      terminated: 0,
    });
  });

  it("terminates each orphaned process group once", async () => {
    const root = "/tmp/paperclip-worktree/PAP-11663-cleanup";
    const terminated: Array<{ pid: number; processGroupId: number | null }> = [];

    const result = await cleanupOrphanedPaperclipRuntimeProcesses({
      containmentRoots: [root],
      currentProcessId: 1,
      currentProcessGroupId: 10,
      registryRecords: [],
      processSnapshots: [
        proc({
          pid: 1200,
          processGroupId: 2200,
          commandLine: `node ${root}/server/src/index.ts`,
          cwd: root,
        }),
        proc({
          pid: 1201,
          processGroupId: 2200,
          commandName: "esbuild",
          commandLine: `esbuild --service=0.28.0 ${root}`,
          cwd: root,
          paperclipRuntimeMarkers: {
            PAPERCLIP_MANAGED_RUNTIME: "workspace-runtime",
          },
        }),
      ],
      terminate: async (record) => {
        terminated.push({ pid: record.pid, processGroupId: record.processGroupId });
      },
    });

    expect(result).toMatchObject({
      scanned: 2,
      matched: 2,
      terminated: 1,
      dryRun: false,
    });
    expect(terminated).toEqual([{ pid: 1200, processGroupId: 2200 }]);
  });
});

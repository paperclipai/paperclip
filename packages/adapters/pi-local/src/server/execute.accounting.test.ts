import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Redirect Pi's session/skill home directories (computed at module scope in
// execute.ts) into an isolated temp home so the local execution path never
// touches the developer's real `~/.pi` directories.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const fs = await import("node:fs");
  const pathModule = await import("node:path");
  const home = fs.mkdtempSync(pathModule.join(actual.tmpdir(), "paperclip-pi-home-"));
  return { ...actual, default: actual, homedir: () => home };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    ensurePiModelConfiguredAndAvailable: vi.fn(async () => [
      { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
    ]),
  };
});

import { execute } from "./execute.js";
import { MAX_CAPTURE_BYTES } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils/types";

// A Pi fixture that streams one turn with usage at the start, then assistant
// content large enough that the process transport's 4 MiB tail cap drops that
// early line from the captured stdout, then a final turn and agent_end. This
// reproduces ROG-183/ROG-190: receipts used to be parsed from the capped
// buffer, silently losing the early usage.
function piFixtureScript() {
  const earlyTurnEnd = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: "EARLY-USAGE-MARKER",
      usage: { input: 1000, output: 200, cacheRead: 5000, cost: { total: 0.1 } },
    },
    toolResults: [],
  };
  const padding = "x".repeat(2_300_000);
  const paddedTurnEnd = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: padding,
      usage: { input: 250, output: 100, cacheRead: 0, cost: { total: 0.07 } },
    },
    toolResults: [],
  };
  const agentEnd = {
    type: "agent_end",
    messages: [
      { role: "assistant", content: "done", usage: null },
    ],
  };
  const events = [earlyTurnEnd, paddedTurnEnd, { ...paddedTurnEnd }, agentEnd];
  return [
    "#!/usr/bin/env node",
    "process.stdout.write(" + JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n") + ");",
    "",
  ].join("\n");
}

describe("pi local usage accounting beyond the stdout capture cap", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it(
    "receipts all usage from a stream whose early usage falls out of the 4 MiB stdout cap",
    async () => {
      const rootDir = await mkdtemp(path.join(path.resolve("/tmp"), "paperclip-pi-cap-"));
      cleanupDirs.push(rootDir);
      const piPath = path.join(rootDir, "pi-fixture.mjs");
      await writeFile(piPath, piFixtureScript());
      await chmod(piPath, 0o755);

      const receipts: AdapterUsageCheckpoint[] = [];
      const result = await execute({
        runId: "run-accounting-cap-1",
        agent: {
          id: "agent-cap-1",
          companyId: "company-1",
          name: "Pi Cap",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: piPath,
          model: "openai/gpt-5.4-mini",
          cwd: rootDir,
        },
        context: {
          paperclipWorkspace: {
            cwd: rootDir,
            source: "project_primary",
          },
          paperclipWorkspaces: [],
        },
        onLog: async () => {},
        onUsage: async (receipt) => {
          receipts.push(receipt);
        },
      } as never);

      // The display buffer really was tail-capped past the early usage line...
      const capturedStdout = String((result.resultJson as { stdout?: unknown }).stdout ?? "");
      expect(capturedStdout.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
      expect(capturedStdout).not.toContain("EARLY-USAGE-MARKER");

      // ...yet the final receipt keeps the full-stream accounting totals,
      // including the usage emitted before the cap window.
      expect(result.usage).toEqual({
        inputTokens: 1000 + 250 + 250,
        cachedInputTokens: 5000,
        outputTokens: 200 + 100 + 100,
      });
      expect(result.costUsd).toBeCloseTo(0.1 + 0.07 + 0.07, 10);
      expect(result.usageBasis).toBe("per_run");
      expect(result.usageComplete).toBe(true);

      // Incremental checkpoints observed the early usage mid-run, before the
      // process finished, and the final checkpoint is complete.
      expect(receipts.some((receipt) => receipt.costUsd === 0.1 && receipt.complete === false)).toBe(true);
      expect(receipts.at(-1)!.complete).toBe(true);
      expect(receipts.at(-1)!.costUsd ?? 0).toBeCloseTo(0.24, 10);
    },
    60_000,
  );
});

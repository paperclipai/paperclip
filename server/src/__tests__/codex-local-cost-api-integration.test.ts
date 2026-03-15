/**
 * Integration tests for costApi integration in codex_local adapter.
 * These tests run a fake codex command and a fake quota HTTP server
 * to verify end-to-end cost delta attribution.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-codex-local/server";

// Writes a minimal fake codex CLI that exits 0 with one turn completed.
async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "session-cost-test" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

// Starts a tiny HTTP server that returns the given quota responses in sequence.
function startQuotaServer(responses: Array<Record<string, unknown>>): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let callIndex = 0;
    const server = http.createServer((_req, res) => {
      const body = responses[callIndex % responses.length] ?? {};
      callIndex += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r, reject) => server.close((err) => (err ? reject(err) : r()))),
      });
    });
  });
}

function baseCtx(commandPath: string, workspace: string, extraConfig: Record<string, unknown> = {}) {
  return {
    runId: "run-cost-test",
    agent: {
      id: "agent-cost-test",
      companyId: "company-1",
      name: "Cost Test Agent",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: commandPath,
      cwd: workspace,
      promptTemplate: "Do work.",
      ...extraConfig,
    },
    context: {},
    authToken: "test-token",
    onLog: async () => {},
  };
}

describe("codex_local costApi integration", () => {
  it("4.3: returns positive costUsd when costApi is configured and delta is positive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cost-api-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    // quota server returns before=3.40, after=3.86 (delta=0.46)
    const quotaServer = await startQuotaServer([
      { usage: { fiveHour: { estimatedCostUsdUsed: 3.40 } } },
      { usage: { fiveHour: { estimatedCostUsdUsed: 3.86 } } },
    ]);

    try {
      const ctx = baseCtx(commandPath, workspace, {
        costApi: {
          url: `http://127.0.0.1:${quotaServer.port}/quota`,
          key: "test-key",
          field: "usage.fiveHour.estimatedCostUsdUsed",
        },
      });

      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);
      expect(result.costUsd).toBeCloseTo(0.46, 5);
    } finally {
      await quotaServer.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("4.4: resume-retry flow returns one run-level delta covering both attempts", async () => {
    // Fake codex that fails first (unknown session error) then succeeds
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cost-api-retry-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const callCountPath = path.join(root, "calls.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(callCountPath, "0", "utf8");

    const retryScript = `#!/usr/bin/env node
const fs = require("node:fs");
const callCountPath = ${JSON.stringify(callCountPath)};
const n = parseInt(fs.readFileSync(callCountPath, "utf8"), 10);
fs.writeFileSync(callCountPath, String(n + 1), "utf8");
if (n === 0 && process.argv.includes("resume")) {
  // Simulate unknown session error on first attempt with resume arg
  process.stderr.write("ERROR codex_core::rollout::list: state db missing rollout path for thread old-session\\n");
  process.exit(1);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "session-retry-test" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
    await fs.writeFile(commandPath, retryScript, "utf8");
    await fs.chmod(commandPath, 0o755);

    // quota server: before=5.00, after first fail=5.10, after retry=5.35
    // execute() takes one before snapshot then one after snapshot at the end
    // so delta = 5.35 - 5.00 = 0.35
    const quotaServer = await startQuotaServer([
      { usage: { fiveHour: { estimatedCostUsdUsed: 5.00 } } },
      { usage: { fiveHour: { estimatedCostUsdUsed: 5.35 } } },
    ]);

    try {
      const ctx = {
        ...baseCtx(commandPath, workspace, {
          costApi: {
            url: `http://127.0.0.1:${quotaServer.port}/quota`,
            key: "test-key",
            field: "usage.fiveHour.estimatedCostUsdUsed",
          },
        }),
        runtime: {
          sessionId: "old-session",
          sessionParams: { sessionId: "old-session", cwd: workspace },
          sessionDisplayId: "old-session",
          taskKey: null,
        },
      };

      const result = await execute(ctx);
      // The retry should succeed
      expect(result.exitCode).toBe(0);
      // One delta for the full run (both attempts included)
      expect(result.costUsd).toBeCloseTo(0.35, 5);
    } finally {
      await quotaServer.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("4.5: no costApi returns costUsd: null (backward compatibility)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cost-api-none-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    try {
      const ctx = baseCtx(commandPath, workspace); // no costApi
      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);
      expect(result.costUsd).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("4.6: quota server error causes costUsd: null but run still succeeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cost-api-err-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    try {
      const ctx = baseCtx(commandPath, workspace, {
        costApi: {
          // Use an unroutable address to simulate network failure
          url: "http://127.0.0.1:1/quota",
          key: "test-key",
          field: "usage.fiveHour.estimatedCostUsdUsed",
          timeoutMs: 500,
        },
      });
      const warnings: string[] = [];
      const result = await execute({ ...ctx, onLog: async (_, msg) => { warnings.push(msg); } });
      expect(result.exitCode).toBe(0);
      expect(result.costUsd).toBeNull();
      expect(warnings.some((w) => w.includes("[paperclip] costApi"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

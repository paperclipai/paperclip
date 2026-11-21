import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { createClaudeAcpExecutor } from "./acp.js";

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const fixture = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-echo-agent.mjs");
const roots: string[] = [];

const page = [
  "<!DOCTYPE html>",
  "<html>",
  "<head>",
  "<title>Attention Required! | Cloudflare</title>",
  "<script>window.__cf_chl_opt={cRay:'8f2a1b3c4d5e6f70'}</script>",
  "</head>",
  "<body>",
  "<div class=\"cf-error-details\">Sorry, you have been blocked</div>",
  "<span>Cloudflare Ray ID: <strong>8f2a1b3c4d5e6f70</strong></span>",
  "</body>",
  "</html>",
].join("\n");
const thrownMessage = `Failed to authenticate. API Error: 403 ${page}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

type FakeHandle = { sessionKey: string; backend: string; runtimeSessionName: string; cwd?: string };

class ThrowingRuntime {
  constructor(readonly throwAt: "ensure_session" | "turn") {}

  async ensureSession(input: { sessionKey: string; cwd?: string }): Promise<FakeHandle> {
    if (this.throwAt === "ensure_session") throw new Error(thrownMessage);
    return { sessionKey: input.sessionKey, backend: "acpx", runtimeSessionName: "runtime-1", cwd: input.cwd };
  }

  startTurn(input: { requestId: string }) {
    const result = Promise.reject(new Error(thrownMessage));
    result.catch(() => {});
    return {
      requestId: input.requestId,
      events: { [Symbol.asyncIterator]: async function* () {} },
      result,
      cancel: async () => {},
      closeStream: async () => {},
    };
  }

  runTurn(): never {
    throw new Error("not used");
  }

  getCapabilities() {
    return { controls: [] };
  }

  getStatus() {
    return Promise.resolve({});
  }

  async setConfigOption() {}

  async setMode() {}

  async cancel() {}

  async close() {}
}

async function execute(input: {
  createRuntime?: AcpxEngineExecutorOptions["createRuntime"];
  env?: Record<string, string>;
}): Promise<AdapterExecutionResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-acp-edge-page-"));
  roots.push(root);
  const run = createClaudeAcpExecutor({ createRuntime: input.createRuntime });
  return run({
    runId: "edge-page",
    agent: { id: "edge-agent", companyId: "edge-company" },
    runtime: {},
    config: {
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixture.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      warmHandleIdleMs: 0,
      cwd: repoRoot,
      stateDir: path.join(root, "state"),
      env: input.env ?? {},
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
  } as never);
}

function expectNoEdgePage(result: AdapterExecutionResult) {
  expect(result.errorCode).toBe("claude_edge_rejected");
  expect(result.errorFamily).toBe("transient_upstream");
  expect(result.errorMessage).toMatch(/not invalid credentials/);
  const persisted = JSON.stringify(result);
  expect(persisted).not.toMatch(/<html|<\/html>|<script|<body/i);
  expect(persisted).not.toContain("__cf_chl_opt");
  expect(persisted).not.toContain("Sorry, you have been blocked");
}

describe("Claude ACP edge page scrubbing on the shared executor result", () => {
  it.each(["ensure_session", "turn"] as const)(
    "replaces every copy of a thrown auth-labelled edge page at %s",
    async (throwAt) => {
      const result = await execute({ createRuntime: () => new ThrowingRuntime(throwAt) as never });

      expectNoEdgePage(result);
      expect(result.summary).toBe(result.errorMessage);
      expect(result.errorMeta).toMatchObject({ category: "auth", errorName: "Error" });
      expect(result.errorMeta?.stackPreview).toBe(result.errorMessage);
    },
  );

  it("replaces every copy of an edge page in a typed terminal access failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-acp-edge-page-typed-"));
    roots.push(root);
    const failureFile = path.join(root, "failure.json");
    await fs.writeFile(failureFile, JSON.stringify({
      title: "Failed to authenticate",
      category: "access",
      details: `API Error: 403 ${page}`,
    }));

    const result = await execute({ env: { PAPERCLIP_ACPX_TYPED_FAILURE_FILE: failureFile } });

    expectNoEdgePage(result);
    expect(result.resultJson?.terminalSessionFailure).toMatchObject({
      category: "access",
      title: "Claude API edge rejection",
      details: "Attention Required! | Cloudflare",
    });
    expect(result.resultJson?.edgeFailure).toMatchObject({ status: 403, challenge: true, requestId: "8f2a1b3c4d5e6f70" });
  });
});

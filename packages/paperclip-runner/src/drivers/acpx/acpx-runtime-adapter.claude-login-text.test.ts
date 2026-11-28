import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpRuntimeEvent } from "acpx/runtime";
import { expect, it, vi } from "vitest";

import { openCodexAcpxRuntime } from "./acpx-runtime-adapter.js";
import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

const QUOTED_LOGIN_TEXT = 'The probe exited 1: "Not logged in · Please run /login". I posted its output.';

async function runTurn() {
  const root = await mkdtemp(join(tmpdir(), "claude-login-text-"));
  const home = join(root, "home"), cwd = join(root, "workspace"), config = join(home, ".claude");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  let sequence = 0;
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], has_more: false }));
      return;
    }
    if (request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean };
    const model = body.model ?? "claude-sonnet-5";
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    const frames: Array<Record<string, unknown>> = [
      { type: "message_start", message: { id: `msg_${++sequence}`, type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: QUOTED_LOGIN_TEXT } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address() as { port: number };

  const entry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  const command: VerifiedAcpxCommandLease = {
    spawn: (args, input) => spawn(process.execPath, [entry, ...(args ?? [])], { ...input, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
    close: async () => undefined,
  };
  const options: AcpxRuntimePortOpenOptions = {
    command,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    cwd,
    stateDirectory: join(root, "state"),
    providerSessionKey: "claude-login-text",
    permissionMode: "approve-all",
    permissionPolicy: { autoApprove: ["read", "write", "execute", "other"], defaultAction: "approve" },
    launchEnvironment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", TMPDIR: root,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false" },
    credentialFenceFds: [42, 43] as const,
    activateCredentialFenceOwner: async () => undefined,
    systemInstructions: "Report the probe output.",
    mcpServers: [],
    retainFailedAdmissionCleanup: vi.fn(),
  } as AcpxRuntimePortOpenOptions;
  let port: Awaited<ReturnType<typeof openCodexAcpxRuntime>> | undefined;
  try {
    port = await openCodexAcpxRuntime(options, {
      awaitProviderOwnership: async () => undefined,
      awaitProviderExit: child => new Promise<void>(resolve => child.once("exit", () => resolve())),
    });
    const turn = port.startTurn({ text: "Run the probe and report its output.", requestId: "turn-1",
      onPermissionRequest: async () => ({ outcome: "allow_once" }) });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) events.push(event);
    return { result: await turn.result, events };
  } finally {
    try { await port?.close({ reason: "sign-in hint verified" }); }
    finally {
      api.closeAllConnections();
      await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}

it("completes a turn whose successful reply quotes the CLI's sign-in hint through the real ACP stream", async () => {
  const { result, events } = await runTurn();
  expect(result).toMatchObject({ status: "completed", stopReason: "end_turn" });
  expect(JSON.stringify(events)).toContain("Please run /login");
}, 60_000);

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OpenCodeServerDriver } from "./opencode-server-driver.js";
import { createCodexTaskEnvelope } from "../../contracts/codex.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

/**
 * Live qualification smoke for the OpenCode V2 server API. It is skipped unless
 * `PAPERCLIP_OPENCODE_LIVE_BIN` points at a V2 `opencode` binary (for example
 * `2.0.26`). Run it against the bundled V1 binary too; the driver adapts to
 * either generation.
 */
const liveBinary = process.env.PAPERCLIP_OPENCODE_LIVE_BIN;

/** This smoke targets the V2 server API; the V1 path is covered by the mocked suite. */
function liveBinaryMajor(binary: string | undefined): number {
  if (!binary) return 0;
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return Number(/(\d+)\./.exec(output)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

const liveEnabled = liveBinaryMajor(liveBinary) === 2;

const TERMINAL = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.cancelled",
]);

async function collectTurn(events: AsyncIterable<PrpEvent>): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (TERMINAL.has(event.eventType)) break;
  }
  return collected;
}

type ProviderTurn =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "hold" };

/**
 * Minimal OpenAI-compatible streaming provider. The first call uses the
 * scripted turn; a call that already carries a tool result returns plain text.
 */
function scriptedProvider(script: {
  turn: ProviderTurn;
  finalText: string;
  onRequest?: (body: unknown) => void;
}) {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed: { model?: string; messages?: Array<{ role?: string }> } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* probe requests */
      }
      script.onRequest?.(parsed);
      const model = parsed.model ?? "fake-model";
      const hasToolResult = (parsed.messages ?? []).some(
        (message) => message.role === "tool",
      );
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (
        delta: Record<string, unknown>,
        finish: string | null = null,
      ) =>
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (hasToolResult || script.turn.kind === "text") {
        chunk({ role: "assistant", content: "" });
        chunk({ content: script.finalText });
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (script.turn.kind === "hold") {
        return; // leave the stream open for the interrupt test
      }
      chunk({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: script.turn.name, arguments: "" },
          },
        ],
      });
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: JSON.stringify(script.turn.args) },
          },
        ],
      });
      chunk({}, "tool_calls");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

async function withDriver(
  input: {
    script: Parameters<typeof scriptedProvider>[0];
    permissionMode?: "allow" | "ask";
    taskEnvelope?: ReturnType<typeof createCodexTaskEnvelope>;
    run: (
      session: Awaited<ReturnType<OpenCodeServerDriver["openSession"]>>,
      root: string,
    ) => Promise<void>;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "oc-live-v2-driver-"));
  const provider = scriptedProvider(input.script);
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === "string")
    throw new Error("provider address missing");
  const providerPort = providerAddress.port;
  const driver = new OpenCodeServerDriver({
    model: "paperclip/fake-model",
    runtimeDirectory: root,
    command: liveBinary!,
    permissionMode: input.permissionMode,
    taskEnvelope: input.taskEnvelope,
    environment: {
      PATH: process.env.PATH,
      PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${providerPort}/v1`,
      PAPERCLIP_AI_PROVIDER_KEY: "live-key",
    },
    onDiagnostic: (message) => console.info("[live-v2 diag]", message),
  });
  let session:
    | Awaited<ReturnType<OpenCodeServerDriver["openSession"]>>
    | undefined;
  try {
    session = await driver.openSession({
      runId: "live-v2",
      normalizedSessionId: "live-v2",
      workingDirectory: root,
    });
    await input.run(session, root);
  } finally {
    await session?.close({ reason: "cleanup" }).catch(() => {});
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

describe.skipIf(!liveEnabled)("live OpenCode V2 driver smoke", () => {
  it("runs a text turn with usage", async () => {
    await withDriver({
      script: { turn: { kind: "text", text: "x" }, finalText: "Live V2 hello." },
      run: async (session) => {
        await session.startTurn({ message: { role: "user", text: "say hi" } });
        const events = await collectTurn(session.events());
        expect(events.map((event) => event.eventType)).toContain("turn.completed");
        expect(await session.usage()).toMatchObject({ input: 7, output: 8 });
      },
    });
  }, 120_000);

  it("executes the Paperclip completion tool directly (native MCP tools)", async () => {
    const taskEnvelope = createCodexTaskEnvelope({
      objective: "Prove dynamic tools on V2.",
      contractRevision: "live-v2",
      criteria: [{ id: "c1", requirement: "Complete the live check." }],
    });
    const result = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "done",
      summary: "Live V2 dynamic tool completed.",
      completionClaim: {
        contractRevision: "live-v2",
        objectiveSatisfied: true,
        criteria: [{ criterionId: "c1", status: "satisfied", evidenceRefs: [] }],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
      attentionRequests: [],
      artifacts: [],
    };
    await withDriver({
      taskEnvelope,
      script: {
        turn: { kind: "tool", name: "paperclip_paperclip_finish", args: result },
        finalText: "Finished.",
      },
      run: async (session) => {
        await session.startTurn({ message: { role: "user", text: "finish" } });
        const events = await collectTurn(session.events());
        const types = events.map((event) => event.eventType);
        expect(types).toContain("run.result.proposed");
        expect(types).toContain("turn.completed");
        expect(
          events.some(
            (event) =>
              event.eventType === "item.completed" &&
              event.payload.kind === "dynamicToolCall",
          ),
        ).toBe(true);
      },
    });
  }, 120_000);

  it("surfaces and resolves a V2 permission request", async () => {
    await withDriver({
      permissionMode: "ask",
      script: {
        turn: { kind: "tool", name: "read", args: { path: "note.txt" } },
        finalText: "Read done.",
      },
      run: async (session, root) => {
        await writeFile(join(root, "note.txt"), "hello\n");
        const { turnId } = await session.startTurn({
          message: { role: "user", text: "read note.txt" },
        });
        const iterator = session.events()[Symbol.asyncIterator]();
        let requestId: string | null = null;
        for (let count = 0; count < 60; count += 1) {
          const event = await iterator.next();
          if (event.done) break;
          if (event.value.eventType === "runtime_request.created") {
            requestId = String(
              (event.value.payload as { request?: { requestId?: string } })
                .request?.requestId ?? "",
            );
            break;
          }
        }
        expect(requestId).toBeTruthy();
        await session.resolveRuntimeRequest?.({
          requestId: requestId!,
          turnId,
          resolution: { action: "accept" },
        });
        const rest = await collectTurn(session.events());
        expect(rest.map((event) => event.eventType)).toContain("turn.completed");
      },
    });
  }, 120_000);

  it("cancels a turn on interrupt", async () => {
    await withDriver({
      script: { turn: { kind: "hold" }, finalText: "" },
      run: async (session) => {
        const { turnId } = await session.startTurn({
          message: { role: "user", text: "hold" },
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        await session.interrupt?.({ turnId });
        const events = await collectTurn(session.events());
        expect(events.map((event) => event.eventType)).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^turn\.(cancelled|interrupted|completed)$/),
          ]),
        );
      },
    });
  }, 120_000);
});

import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

it.each(["idle", "status", "silent", "correcting-idle", "correcting-silent", "busy-idle", "handoff-idle", "handoff-status", "handoff-silent"] as const)("does not restart an interrupted empty OpenCode response: %s", async terminal => {
  const root = await mkdtemp(join(tmpdir(), "opencode-interrupt-empty-"));
  const command = join(root, "fake-opencode.mjs");
  await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), command);
  await chmod(command, 0o755);
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamOpened!: () => void;
  const opened = new Promise<void>(resolve => { streamOpened = resolve; });
  const prompts: unknown[] = [];
  const observed: PrpEvent[] = [];
  const correcting = terminal.startsWith("correcting-");
  const silent = terminal.endsWith("silent");
  const busy = terminal === "busy-idle";
  const handoff = terminal.startsWith("handoff-");
  let ownedSessionId = "";
  const emit = (value: unknown) => stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  let resumed = false;
  const driver = new OpenCodeServerDriver({
    model: "openrouter/controlled-model",
    runtimeDirectory: join(root, "runtime"), command,
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "controlled-fixture-key" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/event") return new Response(new ReadableStream<Uint8Array>({
        start(controller) { stream = controller; streamOpened(); },
      }), { headers: { "Content-Type": "text/event-stream" } });
      const sessionID = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      if (url.pathname.endsWith("/prompt_async")) {
        ownedSessionId = sessionID;
        prompts.push(JSON.parse(String(init?.body)));
        if (resumed) queueMicrotask(() => {
          emit({ type: "message.updated", properties: { info: { id: "resumed-answer", sessionID, role: "assistant", finish: "stop", time: { completed: 2 } } } });
          emit({ type: "message.part.updated", properties: { part: { id: "resumed-part", messageID: "resumed-answer", sessionID, type: "text", text: "The authorized next turn completed.", time: { start: 1, end: 2 } } } });
          emit({ type: "session.idle", properties: { sessionID } });
        });
        else if (correcting && prompts.length === 1) queueMicrotask(() => {
          emit({ type: "session.idle", properties: { sessionID } });
        });
        else if (busy && prompts.length === 1) queueMicrotask(() => {
          emit({ type: "message.updated", properties: { info: { id: "tool-message", sessionID, role: "assistant" } } });
          emit({ type: "message.part.updated", properties: { part: { id: "owned-tool", messageID: "tool-message", sessionID,
            type: "tool", tool: "bash", callID: "owned-call", state: { status: "running", input: { command: "controlled work" } } } } });
        });
        else if (handoff && prompts.length === 1) queueMicrotask(() => {
          emit({ type: "question.asked", properties: { id: "owned-question", sessionID, questions: [
            { question: "Which color should I use?", header: "Color", options: [{ label: "Blue", description: "Use blue." }] },
          ] } });
        });
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/abort")) {
        if (!silent) queueMicrotask(() => {
          emit(!terminal.endsWith("status")
            ? { type: "session.idle", properties: { sessionID } }
            : { type: "session.status", properties: { sessionID, status: { type: "idle" } } });
        });
        return Response.json(true);
      }
      if (url.pathname === "/question/owned-question/reject") return Response.json(true);
      return fetch(input, init);
    },
  });
  const session = await driver.openSession({ runId: "owned-run", normalizedSessionId: "owned-session", workingDirectory: root });
  let collecting: Promise<void> | undefined;
  try {
    await opened;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    collecting = (async () => { for await (const event of session.events()) observed.push(event); })();
    const first = await session.startTurn({ message: { role: "user", text: "Save a plan and wait for approval." } });
    await vi.advanceTimersByTimeAsync(0);
    const allowedPrompts = correcting ? 2 : 1;
    expect(prompts).toHaveLength(allowedPrompts);
    if (handoff) {
      const pending = session.pendingRuntimeRequests?.();
      expect(pending).toHaveLength(1);
      const result = session.handoffRuntimeRequest?.({ requestId: "owned-question", turnId: first.turnId,
        reason: "durable_handoff", signal: new AbortController().signal });
      expect(result?.result).toBe("handed_off");
      await result?.cleanup;
      expect(observed.filter(event => event.eventType === "runtime_request.expired")).toHaveLength(1);
    } else await session.interrupt?.({ turnId: first.turnId, reason: "Durable approval is pending." });
    await vi.advanceTimersByTimeAsync(0);
    // HTTP acknowledgement alone is not a provider terminal. An observed idle
    // is a terminal, but must never authorize a new corrective model request.
    expect(prompts).toHaveLength(allowedPrompts);
    const terminalEvents = () => observed.filter(event => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.eventType));
    expect(terminalEvents()).toHaveLength(silent || busy ? 0 : 1);
    if (!silent && !busy) expect(terminalEvents()[0]?.eventType).toBe("turn.cancelled");
    await vi.advanceTimersByTimeAsync(20_001);
    expect(prompts).toHaveLength(allowedPrompts);
    expect(terminalEvents()).toHaveLength(silent || busy ? 0 : 1);
    if (busy) {
      emit({ type: "message.part.updated", properties: { part: { id: "owned-tool", messageID: "tool-message", sessionID: ownedSessionId,
        type: "tool", tool: "bash", callID: "owned-call", state: { status: "completed", input: { command: "controlled work" }, output: "Work stopped.", time: { start: 1, end: 2 } } } } });
      emit({ type: "session.idle", properties: { sessionID: ownedSessionId } });
      await vi.advanceTimersByTimeAsync(0);
      expect(terminalEvents()).toHaveLength(1);
      expect(terminalEvents()[0]?.eventType).toBe("turn.cancelled");
      expect(prompts).toHaveLength(allowedPrompts);
    }
    if (!silent) {
      resumed = true;
      const next = await session.startTurn({ message: { role: "user", text: "The plan is approved. Continue." } });
      await vi.advanceTimersByTimeAsync(0);
      expect(prompts).toHaveLength(allowedPrompts + 1);
      expect(terminalEvents().filter(event => event.turnId === next.turnId)).toHaveLength(1);
      expect(terminalEvents().find(event => event.turnId === next.turnId)?.eventType).toBe("turn.completed");
      expect(observed.some(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage"
        && event.payload.channel === "final" && event.payload.text === "The authorized next turn completed.")).toBe(true);
    }
  } finally {
    vi.useRealTimers();
    await session.close({ reason: "controlled test complete" });
    await collecting;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

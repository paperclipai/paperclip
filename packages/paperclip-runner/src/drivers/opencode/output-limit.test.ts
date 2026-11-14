import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

const RUNAWAY = `E2E_${"QUIP_".repeat(400)}`;
const ANSWER = "Here is the actual final answer.";

// A provider message that OpenCode finished with `length` was cut off at the
// model output limit. Its text is incomplete and must never become the final
// answer; the turn gets the same single correction as an empty response.
it.each(["limit-then-answer", "limit-twice", "normal"] as const)("does not settle a truncated OpenCode response: %s", async mode => {
  const root = await mkdtemp(join(tmpdir(), "opencode-output-limit-"));
  const command = join(root, "fake-opencode.mjs");
  await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), command);
  await chmod(command, 0o755);
  const prompts: Record<string, any>[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamOpened!: () => void;
  const opened = new Promise<void>(resolve => { streamOpened = resolve; });
  const queued: Uint8Array[] = [];
  const emit = (value: unknown) => { const frame = new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`); if (stream) stream.enqueue(frame); else queued.push(frame); };
  const driver = new OpenCodeServerDriver({
    model: "openrouter/controlled-model", runtimeDirectory: join(root, "runtime"), command,
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "controlled-fixture-key" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; for (const frame of queued.splice(0)) controller.enqueue(frame); streamOpened(); } }), { headers: { "Content-Type": "text/event-stream" } });
      if (url.pathname.endsWith("/prompt_async")) {
        const prompt = JSON.parse(String(init?.body)); prompts.push(prompt);
        const sessionID = decodeURIComponent(url.pathname.split("/")[2]!);
        const number = prompts.length, messageID = `assistant-${number}`;
        const limited = mode === "limit-twice" || mode === "limit-then-answer" && number === 1;
        queueMicrotask(() => {
          emit({ type: "message.updated", properties: { info: { id: messageID, sessionID, role: "assistant" } } });
          emit({ type: "message.part.updated", properties: { sessionID, part: { id: `part-${number}`, messageID,
            type: "text", text: limited ? RUNAWAY : ANSWER, time: { start: 1, end: 2 } } } });
          emit({ type: "message.updated", properties: { info: { id: messageID, sessionID, role: "assistant",
            finish: limited ? "length" : "stop", time: { completed: Date.now() }, tokens: { output: limited ? 32_000 : 12 } } } });
          emit({ type: "session.idle", properties: { sessionID } });
        });
        return new Response(null, { status: 204 });
      }
      return fetch(input, init);
    },
  });
  const session = await driver.openSession({ runId: "owned-run", normalizedSessionId: "owned-session", workingDirectory: root });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await opened;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const collect = async () => { const rows: PrpEvent[] = []; for await (const event of session.events()) {
      rows.push(event); if (["turn.completed", "turn.failed"].includes(event.eventType)) break;
    } return rows; };
    const collected = collect();
    await session.startTurn({ message: { role: "user", text: "Answer the current request." }, reasoningMode: "disabled" });
    const completed = Promise.race([collected, new Promise<PrpEvent[]>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Controlled provider produced no terminal event")), 5_000);
    })]);
    void completed.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_001);
    const events = await completed;
    const final = events.filter(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage" && event.payload.channel === "final");
    const diagnostics = events.filter(event => event.eventType === "harness.diagnostic" && event.payload.code === "opencode_output_limit_reached");
    if (mode === "normal") {
      expect(events.at(-1)?.eventType).toBe("turn.completed");
      expect(final.map(event => event.payload.text)).toEqual([ANSWER]);
      expect(diagnostics).toHaveLength(0);
      expect(prompts).toHaveLength(1);
      return;
    }
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1]!.parts)).toContain("reached the output limit and was discarded");
    expect(JSON.stringify(final)).not.toContain("QUIP");
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    if (mode === "limit-then-answer") {
      expect(events.at(-1)?.eventType).toBe("turn.completed");
      expect(final.map(event => event.payload.text)).toEqual([ANSWER]);
    } else {
      expect(events.at(-1)?.eventType).toBe("turn.failed");
      expect(events.at(-1)?.payload).toMatchObject({ error: { code: "opencode_output_limit_reached" } });
      expect(final).toHaveLength(0);
    }
  } finally {
    clearTimeout(deadline);
    vi.useRealTimers();
    await session.close({ reason: "controlled test complete" });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

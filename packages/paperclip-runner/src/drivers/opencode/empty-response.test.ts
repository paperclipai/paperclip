import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

it.each(["reply", "reply-no-finish", "reply-tool-finish", "two-turn-idle", "slow-native-tool", "idle-stall", "tool-idle-stall", "empty-again", "request-fails", "normal", "foreign-idle", "queued-tool", "reasoning-echo", "reasoning-echo-text-first", "reasoning-echo-reasoning-after", "reasoning-echo-correction-matches"] as const)("handles an empty OpenCode response: %s", async mode => {
  const root = await mkdtemp(join(tmpdir(), "opencode-empty-response-"));
  const command = join(root, "fake-opencode.mjs");
  await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), command);
  await chmod(command, 0o755);
  const prompts: Record<string, any>[] = [];
  // Recorded from chat-eval cohort 5 (tasks.website-task, DeepSeek v4.1 flash
  // through OpenRouter): the step's reasoning, then the same text again as an
  // ordinary text part, and no completion call.
  const recordedReasoning = "Task created and already executing (status in_progress, run dafb...). Good. Reply with link. Use finish. Keep concise.\n\nCompletion contract revision 1, criterion \"objective\". I should call paperclip_finish with done. Include evidence refs maybe task link. Let's do.";
  let toolTimer: ReturnType<typeof setTimeout> | undefined;
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
        if (prompts.length === 2 && mode === "request-fails") throw new Error("controlled correction request failed");
        const sessionID = decodeURIComponent(url.pathname.split("/")[2]!);
        const number = prompts.length, messageID = `assistant-${number}`;
        queueMicrotask(() => {
          if (mode === "foreign-idle") emit({ type: "session.idle", properties: { sessionID: "foreign-session" } });
          const incompleteHeader = number === 2 && ["reply-no-finish", "reply-tool-finish", "idle-stall", "tool-idle-stall", "two-turn-idle"].includes(mode)
            || mode === "two-turn-idle" && number === 4;
          const toolFinish = ["reply-tool-finish", "tool-idle-stall"].includes(mode) || mode === "two-turn-idle" && number === 2;
          emit({ type: "message.updated", properties: { info: { id: messageID, sessionID, role: "assistant",
            ...(incompleteHeader ? toolFinish ? { finish: "tool-calls" } : {} : { finish: "stop", time: { completed: Date.now() } }) } } });
          // Arm the first turn's idle grace before its late completed answer.
          if (mode === "two-turn-idle" && number === 2) emit({ type: "session.idle", properties: { sessionID } });
          if (mode === "slow-native-tool" && number === 2 || mode === "queued-tool") {
            const toolPart = { id: `native-${number}`, messageID, sessionID, type: "tool", tool: "bash", callID: `call-${number}`,
              state: { status: mode === "queued-tool" ? "pending" : "running", input: { command: "owned-controlled-command" } } };
            emit({ type: "message.part.updated", properties: { part: toolPart } });
            if (mode === "slow-native-tool") {
              emit({ type: "session.idle", properties: { sessionID } });
              toolTimer = setTimeout(() => {
                emit({ type: "message.part.updated", properties: { part: { ...toolPart, state: { ...toolPart.state, status: "completed", output: "Owned tool completed.", time: { start: 1, end: 2 } } } } });
                emit({ type: "message.part.updated", properties: { part: { id: `part-${number}`, messageID, sessionID, type: "text", text: "Here is the actual final answer.", time: { start: 3, end: 4 } } } });
                emit({ type: "session.idle", properties: { sessionID } });
              }, 22_000);
              return;
            }
          }
          if (mode === "reasoning-echo-reasoning-after" && number === 1) {
            emit({ type: "message.part.updated", properties: { sessionID, part: { id: "part-1-text", messageID, sessionID, type: "text", text: recordedReasoning, time: { start: 1, end: 2 } } } });
            emit({ type: "message.part.updated", properties: { sessionID, part: { id: "part-1-reasoning", messageID, sessionID, type: "reasoning", text: recordedReasoning, time: { start: 1, end: 3 } } } });
            emit({ type: "session.idle", properties: { sessionID } });
            emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
            return;
          }
          if (mode === "reasoning-echo-text-first" && number === 1) {
            const reasoningPart = { id: "part-1-reasoning", messageID, sessionID, type: "reasoning", text: recordedReasoning, time: { start: 1 } };
            emit({ type: "message.part.updated", properties: { sessionID, part: reasoningPart } });
            emit({ type: "message.part.updated", properties: { sessionID, part: { id: "part-1-text", messageID, sessionID, type: "text", text: recordedReasoning, time: { start: 3, end: 4 } } } });
            emit({ type: "message.part.updated", properties: { sessionID, part: { ...reasoningPart, time: { start: 1, end: 5 } } } });
            emit({ type: "session.idle", properties: { sessionID } });
            emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
            return;
          }
          if ((mode === "reasoning-echo" || mode === "reasoning-echo-correction-matches") && number === 1) {
            const reasoningPart = { id: "part-1-reasoning", messageID, sessionID, type: "reasoning", text: recordedReasoning, time: { start: 1, end: 2 } };
            const echo = { id: "part-1-text", messageID, sessionID, type: "text", text: "", time: { start: 3 } };
            emit({ type: "message.part.updated", properties: { sessionID, part: reasoningPart } });
            emit({ type: "message.part.updated", properties: { sessionID, part: echo } });
            emit({ type: "message.part.delta", properties: { sessionID, messageID, partID: echo.id, field: "text", delta: recordedReasoning.slice(0, 40) } });
            emit({ type: "message.part.delta", properties: { sessionID, messageID, partID: echo.id, field: "text", delta: `${recordedReasoning.slice(40)}\n` } });
            emit({ type: "message.part.updated", properties: { sessionID, part: { ...echo, text: `${recordedReasoning}\n`, time: { start: 3, end: 4 } } } });
            emit({ type: "session.idle", properties: { sessionID } });
            emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
            return;
          }
          const answer = mode === "normal" || mode === "foreign-idle" || mode === "queued-tool" || number === 2 && ["reply", "reply-no-finish", "reply-tool-finish", "two-turn-idle", "reasoning-echo", "reasoning-echo-text-first", "reasoning-echo-reasoning-after", "reasoning-echo-correction-matches"].includes(mode);
          emit({ type: "message.part.updated", properties: { sessionID, part: { id: `part-${number}`, messageID,
            type: answer ? "text" : "reasoning", text: answer ? (mode === "reasoning-echo-correction-matches" ? recordedReasoning : "Here is the actual final answer.") : "Synthetic reasoning must not become the answer.", time: { start: 1, end: 2 } } } });
          emit({ type: "session.idle", properties: { sessionID } });
          emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
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
    // Real process/HTTP setup is complete. Only the controlled event stream
    // and production grace/tool timers advance on this virtual clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const observed: PrpEvent[] = [];
    const collect = async () => { const rows: PrpEvent[] = []; for await (const event of session.events()) {
      rows.push(event); observed.push(event); if (["turn.completed", "turn.failed"].includes(event.eventType)) break;
    } return rows; };
    const guard = (work: Promise<PrpEvent[]>, milliseconds: number) => {
      clearTimeout(deadline);
      const result = Promise.race([work, new Promise<PrpEvent[]>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Controlled provider produced no terminal event")), milliseconds);
      })]);
      void result.catch(() => {});
      return result;
    };
    const collected = collect();
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Answer the current request." }, reasoningMode: mode === "empty-again" || mode === "reply" || mode.startsWith("reasoning-echo") ? "default" : "disabled" });
    const completed = guard(collected, mode.endsWith("idle-stall") || mode === "slow-native-tool" ? 26_000 : 5_000);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "slow-native-tool") {
      await vi.advanceTimersByTimeAsync(20_001);
      expect(observed.some(event => ["turn.completed", "turn.failed"].includes(event.eventType))).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(mode.endsWith("idle-stall") ? 20_001 : mode === "slow-native-tool" ? 1_999 : 5_001);
    const events = await completed;
    const succeeds = ["reply", "reply-no-finish", "reply-tool-finish", "two-turn-idle", "slow-native-tool", "normal", "foreign-idle", "queued-tool", "reasoning-echo", "reasoning-echo-text-first", "reasoning-echo-reasoning-after", "reasoning-echo-correction-matches"].includes(mode);
    expect(events.at(-1)?.eventType).toBe(succeeds ? "turn.completed" : "turn.failed");
    expect(events.filter(event => event.eventType === "turn.started")).toHaveLength(1);
    expect(events.every(event => !event.turnId || event.turnId === turnId)).toBe(true);
    const final = events.filter(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage" && event.payload.channel === "final");
    expect(final.map(event => event.payload.text)).toEqual(succeeds ? [mode === "reasoning-echo-correction-matches" ? recordedReasoning : "Here is the actual final answer."] : []);
    expect(prompts).toHaveLength(["normal", "foreign-idle", "queued-tool"].includes(mode) ? 1 : 2);
    if (prompts.length === 2) {
      expect(prompts[0]!.variant).toBe(mode === "empty-again" || mode === "reply" || mode.startsWith("reasoning-echo") ? "paperclip-default" : "paperclip-no-reasoning");
      expect(prompts[1]).toMatchObject({ providerID: prompts[0]!.providerID, modelID: prompts[0]!.modelID, system: prompts[0]!.system, variant: "paperclip-no-reasoning" });
      expect(JSON.stringify(prompts[1]!.parts)).toContain("Do not repeat completed actions");
    }
    if (mode === "reasoning-echo" || mode === "reasoning-echo-text-first") {
      // The repeated reasoning never reaches the person, as progress or as the reply.
      const assistantText = events.filter(event => event.payload.kind === "agentMessage").map(event => String(event.payload.text ?? ""));
      expect(assistantText.join("")).not.toContain(recordedReasoning.slice(0, 20));
      expect(events.some(event => event.eventType === "harness.diagnostic" && event.payload.code === "opencode_reasoning_echo_discarded")).toBe(true);
    }
    if (mode === "two-turn-idle") {
      const nextEvents = collect();
      const next = await session.startTurn({ message: { role: "user", text: "Answer the next request." }, reasoningMode: "disabled" });
      const nextCompleted = guard(nextEvents, 26_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20_001);
      const rows = await nextCompleted;
      expect(rows.at(-1)?.eventType).toBe("turn.failed");
      expect(rows.every(event => !event.turnId || event.turnId === next.turnId)).toBe(true);
      expect(prompts).toHaveLength(4);
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(toolTimer);
    vi.useRealTimers();
    await session.close({ reason: "controlled test complete" });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

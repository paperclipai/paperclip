import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

// Operator Stop while the provider waits inside a Paperclip MCP tool call.
// runnerd settles the pending call before it asks the driver to interrupt, and
// OpenCode 1.18 can then report the abort as a bare idle. That idle closes the
// stopped turn. It must not count as an empty answer that earns a corrective
// prompt, because that prompt restarts model work after the run is cancelled.
it.each(["idle-after-settle", "idle-before-settle", "aborted-error"] as const)(
  "closes an OpenCode turn interrupted during a pending MCP tool call without new model work: %s",
  async (abortReport) => {
    const root = await mkdtemp(join(tmpdir(), "opencode-interrupt-pending-tool-"));
    const command = join(root, "fake-opencode.mjs");
    await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), command);
    await chmod(command, 0o755);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamOpened!: () => void;
    const opened = new Promise<void>((done) => { streamOpened = done; });
    const prompts: unknown[] = [];
    const aborts: string[] = [];
    const observed: PrpEvent[] = [];
    let ownedSessionId = "";
    const emit = (value: unknown) =>
      stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    let releaseTool!: (outcome: Error) => void;
    const toolReleased = new Promise<Error>((done) => { releaseTool = done; });
    let toolStarted!: () => void;
    const toolCalled = new Promise<void>((done) => { toolStarted = done; });
    const driver = new OpenCodeServerDriver({
      model: "openrouter/controlled-model",
      runtimeDirectory: root,
      command,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "controlled-fixture-key" },
      dynamicTools: [{ name: "paperclip_call_assigned_tool", inputSchema: { type: "object" } }],
      dynamicToolHandler: async () => {
        toolStarted();
        // The controller's gated assigned tool never answers this call: runnerd
        // fails it with its stop courtesy result once the operator stops the run.
        throw await toolReleased;
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/event")
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { stream = controller; streamOpened(); },
          }), { headers: { "Content-Type": "text/event-stream" } });
        const sessionID = decodeURIComponent(url.pathname.split("/")[2] ?? "");
        if (url.pathname.endsWith("/prompt_async")) {
          ownedSessionId = sessionID;
          prompts.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith("/abort")) {
          aborts.push(sessionID);
          if (abortReport === "aborted-error")
            queueMicrotask(() => emit({ type: "session.error", properties: { sessionID,
              error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }));
          if (abortReport === "idle-before-settle")
            queueMicrotask(() => emit({ type: "session.idle", properties: { sessionID } }));
          return Response.json(true);
        }
        return fetch(input, init);
      },
    });
    const session = await driver.openSession({
      runId: "owned-run", normalizedSessionId: "owned-session", workingDirectory: root,
    });
    let collecting: Promise<void> | undefined;
    const settle = () => new Promise((done) => setTimeout(done, 50));
    try {
      await opened;
      collecting = (async () => { for await (const event of session.events()) observed.push(event); })();
      const turn = await session.startTurn({ message: { role: "user", text: "Read the website brief." } });
      expect(prompts).toHaveLength(1);

      // OpenCode calls the Paperclip tool through the authenticated MCP bridge.
      const config = JSON.parse(await readFile(join(root, "owned-session", "config", "opencode", "opencode.json"), "utf8"));
      const bridge = config.mcp.paperclip as { url: string; headers: Record<string, string> };
      emit({ type: "message.updated", properties: { info: { id: "tool-message", sessionID: ownedSessionId, role: "assistant" } } });
      const toolResponse = fetch(bridge.url, {
        method: "POST",
        headers: { ...bridge.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "assigned-call", method: "tools/call",
          params: { name: "paperclip_call_assigned_tool", arguments: { name: "read_website_brief", arguments: {} } } }),
      });
      await toolCalled;

      const terminalEvents = () => observed.filter((event) =>
        ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.eventType));
      if (abortReport === "idle-after-settle") {
        // runnerd answers the pending call before it interrupts the turn.
        releaseTool(new Error("Paperclip stopped the active provider turn"));
        await toolResponse;
      }
      await session.interrupt?.({ turnId: turn.turnId, reason: "Cancelled by a board operator" });
      expect(aborts).toEqual([ownedSessionId]);
      await settle();
      if (abortReport !== "idle-after-settle") {
        // The stopped provider abandons its tool call; the late courtesy result
        // must not reopen the turn either.
        releaseTool(new Error("Paperclip stopped the active provider turn"));
        await toolResponse;
        await settle();
      }
      if (abortReport !== "aborted-error")
        emit({ type: "session.idle", properties: { sessionID: ownedSessionId } });
      // Wait for the terminal frame with a bound rather than a fixed delay, then
      // give a corrective prompt (the regression) time to appear.
      await expect.poll(terminalEvents, { timeout: 5_000 }).toHaveLength(1);
      await settle();

      expect(prompts).toHaveLength(1);
      expect(terminalEvents().map((event) => [event.eventType, event.turnId])).toEqual([
        ["turn.cancelled", turn.turnId],
      ]);
      expect(observed.some((event) => event.eventType === "harness.diagnostic"
        && event.payload.code === "opencode_empty_response_correction")).toBe(false);
    } finally {
      releaseTool(new Error("test cleanup"));
      await session.close({ reason: "controlled test complete" });
      await collecting;
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

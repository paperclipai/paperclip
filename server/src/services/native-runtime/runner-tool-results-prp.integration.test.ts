import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { createAssignedMcpTools } from "./assigned-mcp-tools.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { READ_TOOL_RESULT, RUNNER_TOOL_RESULT_MAX_BYTES } from "./runner-tool-results.js";
import type { ToolGatewayService } from "../tool-gateway.js";

function createPrpTransferWatchdog(timeoutMs: number, evidence: () => unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let closed = false;
  let failure: Error | undefined;
  let rejectWatchdog: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => { rejectWatchdog = reject; });
  void promise.catch(() => undefined);
  const schedule = (label: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      failure = new Error(`PRP transfer made no Authority progress for ${timeoutMs}ms after ${label}: ${JSON.stringify(evidence())}`);
      rejectWatchdog?.(failure);
    }, timeoutMs);
  };
  return {
    promise,
    get failure() { return failure; },
    start(label: string) {
      if (started || closed || failure) return;
      started = true;
      schedule(label);
    },
    responseCompleted(label: string) {
      if (!started || closed || failure) return;
      schedule(label);
    },
    fail(error: Error) {
      if (closed || failure) return;
      failure = error;
      clearTimeout(timer);
      timer = undefined;
      rejectWatchdog?.(error);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

describe("PRP transfer watchdog", () => {
  afterEach(() => vi.useRealTimers());

  it("fails when the first Authority response never arrives", async () => {
    vi.useFakeTimers();
    const watchdog = createPrpTransferWatchdog(15_000, () => ({ phase: "waiting" }));
    watchdog.start("waiting for first Authority response");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(watchdog.failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(watchdog.promise).rejects.toThrow("15000ms");
  });

  it("does not reset on request start, but advances after a completed response", async () => {
    vi.useFakeTimers();
    const requestStartWatchdog = createPrpTransferWatchdog(15_000, () => ({}));
    requestStartWatchdog.start("first response");
    await vi.advanceTimersByTimeAsync(10_000);
    requestStartWatchdog.start("request started");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(requestStartWatchdog.failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(requestStartWatchdog.promise).rejects.toThrow("first response");

    const responseWatchdog = createPrpTransferWatchdog(15_000, () => ({}));
    responseWatchdog.start("first response");
    await vi.advanceTimersByTimeAsync(10_000);
    responseWatchdog.responseCompleted("first response completed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(responseWatchdog.failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(responseWatchdog.failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(responseWatchdog.promise).rejects.toThrow("first response completed");
  });

  it("rejects the observed promise immediately on an Authority error", async () => {
    vi.useFakeTimers();
    const watchdog = createPrpTransferWatchdog(15_000, () => ({}));
    watchdog.start("request in progress");
    const failure = new Error("Authority request failed");
    watchdog.fail(failure);
    await expect(watchdog.promise).rejects.toBe(failure);
    expect(watchdog.failure).toBe(failure);
  });

  it("does not rearm after close", async () => {
    vi.useFakeTimers();
    const watchdog = createPrpTransferWatchdog(15_000, () => ({}));
    watchdog.start("request in progress");
    watchdog.close();
    watchdog.responseCompleted("late response");
    await vi.advanceTimersByTimeAsync(15_001);
    expect(watchdog.failure).toBeUndefined();
  });
});

describe("saved assigned results through actual PRP", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  it.skipIf(!process.env.PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION && !existsSync(defaultCapabilityRunnerdBinary()))("delivers escape-heavy 500 KB pages through actual PRP without truncation", async ({ onTestFailed }) => {
    const fixture = await server.fixture({ apiToolsEnabled: false });
    const original = { content: '🧭é"\\\n\u0000'.repeat(60_000), last: "complete-result" };
    const expected = JSON.stringify(original);
    const digest = createHash("sha256").update(expected).digest("hex");
    const inline = { content: "\\".repeat(200_000) };
    const inlineDigest = createHash("sha256").update(JSON.stringify(inline)).digest("hex");
    const providerWireSize = (value: unknown) => Buffer.byteLength(JSON.stringify({ success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(value) }] }));
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeLessThan(RUNNER_TOOL_RESULT_MAX_BYTES);
    expect(providerWireSize(inline)).toBeGreaterThan(RUNNER_TOOL_RESULT_MAX_BYTES);
    const executeTool = vi.fn(async (call: { parameters: Record<string, unknown> }) => ({
      status: "completed" as const, result: call.parameters.variant === "inline" ? inline : original,
    }));
    const assignedMcpTools = await createAssignedMcpTools({
      gatewayPublicId: "fixture", bearerToken: "fixture",
      gateway: {
        listToolsForNamedGateway: async () => [{ name: "app:read", displayName: "Read", description: "Fixture read",
          parametersSchema: { type: "object", properties: { variant: { type: "string", enum: ["large", "inline"] } } },
          pluginId: "fixture", providerType: "mcp_remote_http", risk: "read" }],
        executeTool,
      } as unknown as ToolGatewayService,
    });
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture.authority.binding, assignedMcpTools });
    const provider = join(server.root, "scripted-saved-result-provider.mjs");
    await writeFile(provider, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let step=0, artifactId, restored='', phase=0;
const call = (tool,args) => { step++; send({id:'call-'+step,method:'item/tool/call',params:{threadId:'saved-thread',turnId:'saved-turn',itemId:'item-'+step,callId:'saved-call-'+step,tool,arguments:args}}); };
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);
  if (!m.method) {
    if (String(m.id).startsWith('call-')) {
      const envelope=JSON.parse(m.result.contentItems[0].text);
      const result=envelope.result ?? envelope;
      if (result.artifact) {
        if(!result.readWith || result.readWith.tool!=='read_tool_result' || result.readWith.arguments.offsetBytes!==0) throw new Error('Captured result omitted its first-page instruction');
        artifactId=result.artifact.artifactId;
        restored='';
        call(result.readWith.tool,{...result.readWith.arguments});
      } else {
        if(!result.ok || result.responseText.offsetBytes!==Buffer.byteLength(restored)) throw new Error('Invalid page receipt');
        restored+=result.data;
        if(result.responseText.nextOffsetBytes!==null) call('read_tool_result',{artifactId,offsetBytes:result.responseText.nextOffsetBytes});
        else {
          const expectedDigest=phase===0?'${digest}':'${inlineDigest}';
          if(createHash('sha256').update(restored).digest('hex')!==expectedDigest) throw new Error('Provider received incomplete saved JSON');
          if(phase===0) { phase=1; call('${assignedMcpTools.definitions()[0]!.name}',{variant:'inline'}); }
          else {
            send({method:'item/completed',params:{threadId:'saved-thread',turnId:'saved-turn',item:{id:'saved-answer',type:'agentMessage',text:'all-pages-verified'}}});
            send({method:'turn/completed',params:{turn:{id:'saved-turn',status:'completed'}}});
          }
        }
      }
    }
    continue;
  }
  if(m.method==='initialize') send({id:m.id,result:{userAgent:'scripted-saved-result-provider'}});
  else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'saved-thread',sessionId:'saved-session'}}});
  else if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'saved-turn',status:'inProgress'}}});send({method:'turn/started',params:{turn:{id:'saved-turn'}}});call('${assignedMcpTools.definitions()[0]!.name}',{variant:'large'});}
  else if(m.id!==undefined) send({id:m.id,result:{}});
}
`);
    await chmod(provider, 0o700);
    const bundle = createRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: provider, codexArgs: [],
      stateDirectory: join(server.root, "scripted-saved-result-runner"), lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: { runnerInstanceId: "saved-test", environmentLeaseId: "saved-test-lease", runId: fixture.runId,
        normalizedSessionId: "saved-test-session", turnId: "saved-test-turn", itemId: "saved-test-item" },
    });
    const transferStartedAt = { value: null as number | null };
    const transferCalls: Array<{
      tool: string;
      phase: string;
      offsetBytes: number | null;
      page: number | null;
      startedMs: number;
      completedMs: number;
      gapMs: number;
      resultBytes: number;
      wrapperBytes: number;
    }> = [];
    let activeTransferCall: Omit<(typeof transferCalls)[number], "completedMs" | "gapMs" | "resultBytes" | "wrapperBytes"> | null = null;
    let activePhase = "large";
    let page = 0;
    let lastCompletedAt: number | undefined;
    let failedTransferCall: { tool: string; phase: string; offsetBytes: number | null; page: number | null; startedMs: number; failedMs: number; errorType: string } | null = null;
    const sizes: Array<{ result: number; wrapper: number }> = [];
    const elapsedMs = () => Math.round(performance.now() - (transferStartedAt.value ?? testStartedAt));
    const failureEvidence = () => {
      const evidence = bundle.evidence();
      return {
        sizes: sizes.slice(-8),
        transfer: {
          elapsedMs: elapsedMs(),
          lastCalls: transferCalls.slice(-8),
          activeCall: activeTransferCall,
          failedCall: failedTransferCall,
          maxCompletionGapMs: Math.max(0, ...transferCalls.map((call) => call.gapMs)),
        },
        notifications: notifications.slice(-12),
        runnerExited: evidence.runnerExited,
        runnerExitCode: evidence.runnerExitCode,
        runnerSignal: evidence.runnerSignal,
        // Diagnostics are useful to explain a native transport timeout, but
        // cap both count and text length so failures cannot dump unbounded logs.
        diagnostics: evidence.diagnostics.slice(-8).map((message) => message.slice(0, 300)),
      };
    };
    const testStartedAt = performance.now();
    const transferWatchdog = createPrpTransferWatchdog(15_000, failureEvidence);
    const transferStalled = transferWatchdog.promise;
    const requestDuringTransfer = (method: string, params: Record<string, unknown>) =>
      Promise.race([bundle.transport.request(method, params), transferStalled]);
    bundle.transport.setServerRequestHandler(async request => {
      if (transferWatchdog.failure) throw transferWatchdog.failure;
      const params = request.params;
      const tool = String(params.tool);
      const args = typeof params.arguments === "object" && params.arguments !== null
        ? params.arguments as Record<string, unknown>
        : {};
      if (tool !== READ_TOOL_RESULT) {
        activePhase = args.variant === "inline" ? "inline" : "large";
        page = 0;
      } else {
        page += 1;
      }
      const transferStart = transferStartedAt.value ?? performance.now();
      transferStartedAt.value ??= transferStart;
      const offsetBytes = Number.isSafeInteger(args.offsetBytes) ? Number(args.offsetBytes) : null;
      const startedMs = Math.round(performance.now() - transferStart);
      const progress = {
        tool,
        phase: activePhase,
        offsetBytes,
        page: tool === READ_TOOL_RESULT ? page : null,
        startedMs,
      };
      activeTransferCall = progress;
      try {
        const result = await authority.execute({ tool, arguments: params.arguments, callId: String(params.callId) });
        if (transferWatchdog.failure) throw transferWatchdog.failure;
        const response = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
        const resultBytes = Buffer.byteLength(JSON.stringify(result));
        const wrapperBytes = Buffer.byteLength(JSON.stringify(response));
        const completedAt = performance.now();
        const completedMs = Math.round(completedAt - transferStart);
        transferCalls.push({ ...progress, completedMs,
          gapMs: Math.round(completedAt - (lastCompletedAt ?? transferStart)),
          resultBytes, wrapperBytes });
        lastCompletedAt = completedAt;
        sizes.push({ result: resultBytes, wrapper: wrapperBytes });
        activeTransferCall = null;
        transferWatchdog.responseCompleted(`${tool} phase=${activePhase} page=${progress.page ?? "action"} offset=${offsetBytes ?? "n/a"} response-complete`);
        return response;
      } catch (error) {
        failedTransferCall = {
          tool,
          phase: activePhase,
          offsetBytes,
          page: progress.page,
          startedMs,
          failedMs: Math.round(performance.now() - transferStart),
          errorType: error instanceof Error ? error.name : "UnknownError",
        };
        activeTransferCall = null;
        transferWatchdog.fail(new Error("PRP Authority request failed", { cause: error }));
        throw error;
      }
    });
    let testFailure: unknown;
    let verified = false;
    const notifications: Array<{ method: string; type: unknown; status?: string }> = [];
    onTestFailed(() => {
      console.info(`[PRP fixture] failure ${JSON.stringify(failureEvidence())}`);
    });
    try {
      await requestDuringTransfer("initialize", {});
      await requestDuringTransfer("thread/start", { cwd: fixture.workspace, dynamicTools: authority.definitions() });
      transferStartedAt.value = performance.now();
      transferWatchdog.start("waiting for first Authority response");
      await requestDuringTransfer("turn/start", { input: [{ type: "text", text: "Read every saved result page" }] });
      await Promise.race([
        (async () => { for await (const notification of bundle.transport.notifications()) {
          notifications.push({ method: notification.method, type: (notification.params.item as { type?: string })?.type,
            status: (notification.params.turn as { status?: string })?.status });
          if (notification.method === "item/completed" && (notification.params.item as { text?: string })?.text === "all-pages-verified") verified = true;
          if (notification.method === "turn/completed") {
            const status = (notification.params.turn as { status?: string })?.status;
            if (status !== "completed") throw new Error(`PRP turn ended with status ${status ?? "unknown"}: ${JSON.stringify(failureEvidence())}`);
            transferWatchdog.close();
            return;
          }
          if (notification.method === "turn/failed" || notification.method === "item/failed") {
            transferWatchdog.close();
            throw new Error(`PRP emitted terminal ${notification.method}: ${JSON.stringify(failureEvidence())}`);
          }
        } })(),
        transferStalled,
      ]);
      expect(verified, JSON.stringify(failureEvidence())).toBe(true);
      expect(executeTool.mock.calls.map(([call]) => call.parameters)).toEqual([{ variant: "large" }, { variant: "inline" }]);
      expect(sizes.every(size => size.wrapper <= RUNNER_TOOL_RESULT_MAX_BYTES)).toBe(true);
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");
      console.info(`[PRP fixture] complete ${JSON.stringify({
        transferMs: elapsedMs(),
        calls: transferCalls.length,
        maxCompletionGapMs: Math.max(0, ...transferCalls.map((call) => call.gapMs)),
        lastCalls: transferCalls.slice(-8),
      })}`);
    } catch (error) {
      testFailure = new Error(`PRP saved-result test failed: ${error instanceof Error ? error.message : String(error)}; bounded evidence: ${JSON.stringify(failureEvidence())}`, { cause: error });
    } finally {
      transferWatchdog.close();
      try {
        await bundle.transport.close();
      } catch (cleanupError) {
        if (testFailure !== undefined) throw new AggregateError([testFailure, cleanupError], "PRP test and transport cleanup both failed");
        throw new Error(`PRP transport cleanup failed; bounded evidence: ${JSON.stringify(failureEvidence())}`, { cause: cleanupError });
      }
    }
    if (testFailure !== undefined) throw testFailure;
  }, 30_000);
});

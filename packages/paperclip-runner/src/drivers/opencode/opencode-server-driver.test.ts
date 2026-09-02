import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../../contracts/runtime-context.js";
import { OpenCodeServerDriver, openCodeServerDriverInternals } from "./opencode-server-driver.js";

const roots: string[] = [];
const fixture = resolve("test/fixtures/fake-opencode-server.mjs");

function runtimeContext(skillRoot: string, instructionRoot: string): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    },
    skills: [{
      key: "company/assigned",
      runtimeName: "assigned",
      versionId: "version-1",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: skillRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    }],
    mcp: { assignmentSetId: "assigned", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
}

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeWritable(join(root, entry));
  } else {
    await chmod(root, 0o600);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("OpenCodeServerDriver", () => {
  it("advertises within-turn plans as unsupported", async () => {
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: "/tmp/paperclip-opencode-capabilities",
      command: fixture,
    });
    const descriptor = await driver.descriptor();
    expect(descriptor.capabilities.typedEventFamilies
      .find((family) => family.family === "plan"))
      .toMatchObject({ availability: "unsupported" });
  });

  it("starts an authenticated isolated server, creates a session, streams usage, aborts, and cleans up", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const tracePath = join(root, "provider-trace.ndjson");
    const spawns: Array<{ pid: number; processGroupId: number | null }> = [];
    const diagnostics: string[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "test-openrouter-key",
        PAPERCLIP_API_KEY: "must-not-leak",
        UNRELATED_SECRET: "must-not-leak",
        PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
        PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(64 * 1024 * 1024),
      },
      onSpawn: async (meta) => { spawns.push(meta); },
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const session = await driver.openSession({ runId: "run-1", normalizedSessionId: "normalized/1", workingDirectory: workspace });
    expect(session.ids()).toMatchObject({ providerSessionId: "ses_fake_1" });
    expect(spawns).toHaveLength(1);
    const turn = await session.startTurn({ message: { role: "user", text: "finish" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.map((event) => event.eventType)).toContain("turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ eventType: "run.result.proposed" }));
    expect(events.filter((event) => event.eventType === "item.delta")).toHaveLength(1);
    expect(events.find((event) => event.eventType === "item.delta")?.payload.text).toBe("done [guide](guide.md)");
    expect(events.find(
      (event) => event.eventType === "item.completed" && event.payload.kind === "agentMessage",
    )?.payload).toMatchObject({
      channel: "final",
      providerPhase: "final_answer",
      text: "done [guide](guide.md)",
    });
    expect(events.filter(
      (event) => event.eventType === "item.completed" && event.payload.kind === "usage",
    )).toHaveLength(1);
    expect(events.find((event) => event.eventType === "workspace.change.updated")?.payload)
      .toMatchObject({ schema: "paperclip.workspace.diff.v1", source: "harness_reported", totals: { files: 1 } });
    expect(events.find((event) => event.eventType === "workspace.diff.recorded")?.payload)
      .toMatchObject({ schema: "paperclip.workspace.diff.v1", complete: true });
    expect(events.find((event) => event.eventType === "workspace.file.referenced")?.payload)
      .toMatchObject({ schema: "paperclip.workspace.file_reference.v1", path: "guide.md" });
    expect(JSON.stringify(events)).not.toContain("submitted prompt must not become assistant text");
    expect(await session.usage()).toMatchObject({
      input: 3,
      output: 2,
      costUsd: 0.001,
      provider: "openrouter",
      driverVersion: "1.18.17",
    });
    await session.interrupt?.({ turnId: turn.turnId });
    const snapshot = await session.snapshot();
    expect(snapshot.driverKind).toBe("opencode_server");
    const sessionRoot = join(root, "normalized_1");
    expect((await stat(sessionRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(sessionRoot, "config", "opencode", "opencode.json"))).mode & 0o777).toBe(0o600);
    const config = await readFile(join(sessionRoot, "config", "opencode", "opencode.json"), "utf8");
    await session.close({ reason: "test" });
    const recovered = await driver.recoverSession?.(snapshot);
    expect(recovered).toMatchObject({ recovered: true });
    await expect(recovered?.session?.read?.()).resolves.toMatchObject({ sessionId: "ses_fake_1", messages: [] });
    await recovered?.session?.close({ reason: "recovery-test" });

    const traceEntries = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const traceFrames = traceEntries.filter((entry) => entry.kind === "frame");
    expect(traceFrames.map((entry) => entry.direction)).toEqual(
      expect.arrayContaining(["client_to_provider", "provider_to_client", "provider_stderr"]),
    );
    expect(traceFrames.some((entry) => entry.nativeMethod === "SSE /event")).toBe(true);
    expect(traceEntries.some(
      (entry) => entry.stage === "typescript_opencode_driver_normalization"
        && Array.isArray(entry.emittedEventIds)
        && entry.emittedEventIds.length > 0,
    )).toBe(true);
    expect(traceEntries.at(-1)).toMatchObject({
      kind: "trace_status",
      debugChannel: "typescript_opencode_native",
      status: "complete",
    });

    const environment = JSON.parse(await readFile(join(sessionRoot, "data", "fake-environment.json"), "utf8"));
    const mcpEvidence = JSON.parse(await readFile(join(sessionRoot, "data", "fake-mcp-evidence.json"), "utf8"));
    expect(environment.keys).toContain("OPENROUTER_API_KEY");
    expect(environment.keys).not.toContain("PAPERCLIP_API_KEY");
    expect(environment.keys).not.toContain("UNRELATED_SECRET");
    expect(environment.keys).not.toContain("PAPERCLIP_PROVIDER_TRACE_PATH");
    expect(environment.projectConfigDisabled).toBe("true");
    expect(mcpEvidence.tools).toEqual(expect.arrayContaining(["paperclip_finish", "paperclip_block"]));
    expect(config).toContain("openrouter/deepseek/deepseek-v4-flash-0731");
    expect(config).toContain('"*": "allow"');
    expect(config).toContain('"external_directory": "deny"');
    expect(events.some((event) => event.eventType === "runtime_request.created")).toBe(false);
    expect(config).not.toContain("test-openrouter-key");
    expect(diagnostics.join("\n")).not.toContain("test-openrouter-key");
    expect(diagnostics.join("\n")).toContain("[REDACTED]");
  });

  it("maps OpenCode's normal abort error to cancellation without a false provider failure notice", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-abort-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-abort-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({
      runId: "run-aborted",
      normalizedSessionId: "aborted",
      workingDirectory: workspace,
    });
    await session.startTurn({ message: { role: "user", text: "session-aborted" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.map((event) => event.eventType)).toContain("turn.cancelled");
    expect(events.map((event) => event.eventType)).not.toContain("turn.failed");
    expect(events.map((event) => event.eventType)).not.toContain("provider.notice.recorded");
    await session.close({ reason: "test" });
  });

  it("keeps OpenCode in an outer supervisor process group when requested", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    let processGroupId: number | null | undefined;
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      isolateProcessGroup: false,
      onSpawn: async (meta) => { processGroupId = meta.processGroupId; },
    });
    const session = await driver.openSession({ runId: "run-supervised", normalizedSessionId: "supervised", workingDirectory: workspace });
    expect(processGroupId).toBeNull();
    await session.close({ reason: "test" });
  });

  it("uses the native system channel, selected skill tree, instruction root, and assigned MCP gateway", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-context-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-context-workspace-"));
    const skillRoot = join(root, "skill-source");
    const instructionRoot = join(root, "instruction-source");
    roots.push(root, workspace);
    await Promise.all([
      mkdir(join(skillRoot, "references"), { recursive: true }),
      mkdir(instructionRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(skillRoot, "SKILL.md"), "# Assigned\nRead references/support.md\n"),
      writeFile(join(skillRoot, "references", "support.md"), "skill support\n"),
      writeFile(join(instructionRoot, "AGENTS.md"), "Read sibling.md\n"),
      writeFile(join(instructionRoot, "sibling.md"), "instruction sibling\n"),
    ]);
    const systemInstructions = `${PAPERCLIP_EXECUTION_PROMPT}\n\nRead sibling.md\n\nRead-only instruction sibling root: ${instructionRoot}`;
    let submittedPrompt: Record<string, unknown> | null = null;
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      systemInstructions,
      runtimeContext: runtimeContext(skillRoot, instructionRoot),
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40),
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/prompt_async")) submittedPrompt = JSON.parse(String(init?.body));
        return fetch(input, init);
      },
    });
    const session = await driver.openSession({
      runId: "run-context",
      normalizedSessionId: "context",
      workingDirectory: workspace,
    });
    await session.startTurn({ message: { role: "user", text: "finish" } });
    for await (const event of session.events()) {
      if (event.eventType === "turn.completed") break;
    }
    expect(submittedPrompt).toMatchObject({
      system: systemInstructions,
      tools: { question: true },
    });
    expect(JSON.stringify(submittedPrompt?.parts ?? null)).not.toContain(PAPERCLIP_EXECUTION_PROMPT);
    const sessionRoot = join(root, "context");
    const isolatedHomes = (await readdir(sessionRoot)).filter((entry) => entry.startsWith("home-"));
    expect(isolatedHomes).toHaveLength(1);
    await expect(readFile(join(sessionRoot, isolatedHomes[0]!, ".claude", "skills", "assigned", "references", "support.md"), "utf8"))
      .resolves.toBe("skill support\n");
    const config = JSON.parse(await readFile(join(sessionRoot, "config", "opencode", "opencode.json"), "utf8"));
    expect(config).toMatchObject({
      instructions: [],
      plugin: [],
      tools: { question: true },
      permission: { external_directory: { "*": "deny", [`${instructionRoot}/**`]: "allow" } },
      mcp: {
        paperclip: { enabled: true },
        "paperclip-assigned": { url: "https://paperclip.example/mcp", enabled: true },
      },
    });
    await expect(readFile(join(instructionRoot, "sibling.md"), "utf8")).resolves.toBe("instruction sibling\n");
    await session.close({ reason: "test" });
  });

  it("sends only the authoritative wake envelope when resuming an existing provider session", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-resume-context-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-resume-workspace-"));
    roots.push(root, workspace);
    let submittedPrompt: Record<string, unknown> | null = null;
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      systemInstructions: "large original system context",
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      fetch: async (input, init) => {
        if (String(input).endsWith("/prompt_async")) submittedPrompt = JSON.parse(String(init?.body));
        return fetch(input, init);
      },
    });
    const seed = await driver.openSession({
      runId: "run-seed",
      normalizedSessionId: "resume-context",
      workingDirectory: workspace,
    });
    const snapshot = await seed.snapshot();
    await seed.close({ reason: "seed complete" });

    const recovered = await driver.recoverSession?.(snapshot);
    expect(recovered).toMatchObject({ recovered: true });
    await recovered!.session!.startTurn({
      message: { role: "user", text: "{\"interactionResponses\":[{\"answer\":\"friendly\"}]}" },
    });
    for await (const event of recovered!.session!.events()) {
      if (event.eventType === "turn.completed") break;
    }

    expect(submittedPrompt).toMatchObject({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash-0731",
      tools: { question: true },
      parts: [{ type: "text", text: "{\"interactionResponses\":[{\"answer\":\"friendly\"}]}" }],
    });
    expect(submittedPrompt).not.toHaveProperty("system");
    await recovered!.session!.close({ reason: "recovery-test" });
  });

  it("normalizes native question.asked events and replies with ordered OpenCode answer arrays", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-question-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-question-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({
      runId: "run-native-question",
      normalizedSessionId: "native-question",
      workingDirectory: workspace,
    });
    const { turnId } = await session.startTurn({ message: { role: "user", text: "native-question" } });
    const iterator = session.events()[Symbol.asyncIterator]();
    let requestEvent: Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
    for (let count = 0; count < 30; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (event.value.eventType === "runtime_request.created") {
        requestEvent = event.value;
        break;
      }
    }
    expect(requestEvent?.payload).toMatchObject({
      request: {
        schema: "paperclip.runtime_request.v2",
        requestKind: "runtime",
        type: "input",
        input: {
          schema: "paperclip.question_set.v1",
          questions: [
            { id: "environment", answerMode: "single_select", required: false, customAnswer: { enabled: true } },
            { id: "regions", answerMode: "multi_select", required: false },
          ],
        },
      },
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    await session.resolveRuntimeRequest?.({
      requestId: "question-native-1",
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            environment: { customText: "Canary" },
            regions: { selectedOptionIds: ["option-1", "option-2"] },
          },
        },
      },
    });
    const reply = JSON.parse(await readFile(join(root, "native-question", "data", "fake-question-reply.json"), "utf8"));
    expect(reply).toEqual({
      url: expect.stringContaining(`directory=${encodeURIComponent(workspace)}`),
      body: { answers: [["Canary"], ["US", "EU"]] },
    });
    const terminalQuestionEvents = (await session.transcript?.())?.events.filter((event) =>
      event.payload.requestId === "question-native-1"
      && ["runtime_request.resolved", "runtime_request.cancelled"].includes(event.eventType)
    ) ?? [];
    expect(terminalQuestionEvents).toHaveLength(1);
    expect(terminalQuestionEvents[0]?.payload).toMatchObject({
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          environment: { customText: "Canary" },
          regions: { selectedOptionIds: ["option-1", "option-2"] },
        },
      },
    });
    await session.close({ reason: "test" });
  });

  it("hands a native question to the durable interaction path without touching permissions", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-question-handoff-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-question-handoff-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({
      runId: "run-native-question-handoff",
      normalizedSessionId: "native-question-handoff",
      workingDirectory: workspace,
    });
    const { turnId } = await session.startTurn({ message: { role: "user", text: "native-question" } });
    const iterator = session.events()[Symbol.asyncIterator]();
    let created: Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
    for (let count = 0; count < 30; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.eventType === "runtime_request.created") {
        created = next.value;
        break;
      }
    }
    expect(created).toMatchObject({
      payload: { request: { requestId: "question-native-1", type: "input" } },
    });

    const firstHandoff = session.handoffRuntimeRequest?.({
      requestId: "question-native-1",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(firstHandoff?.result).toBe("handed_off");
    await firstHandoff?.cleanup;
    const repeatedHandoff = session.handoffRuntimeRequest?.({
      requestId: "question-native-1",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(repeatedHandoff?.result).toBe("already_settled");
    await repeatedHandoff?.cleanup;

    let expired: Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
    for (let count = 0; count < 20; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.eventType === "runtime_request.expired") {
        expired = next.value;
        break;
      }
    }
    expect(expired).toMatchObject({
      payload: {
        requestId: "question-native-1",
        reason: "durable_handoff",
        replayAllowed: false,
        requestType: "input",
        request: {
          schema: "paperclip.runtime_request.v2",
          requestId: "question-native-1",
          type: "input",
        },
      },
    });
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    const terminal = (await session.transcript?.())?.events.filter((event) =>
      event.payload.requestId === "question-native-1"
      && ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(event.eventType)
    );
    expect(terminal).toHaveLength(1);
    await session.close({ reason: "handoff test complete" });
  });

  it("recovers a missed pending question from the list endpoint and rejects it", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-question-recovery-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-question-recovery-workspace-"));
    roots.push(root, workspace);
    const normalizedSessionId = "question-recovery";
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const seed = await driver.openSession({
      runId: "run-question-recovery",
      normalizedSessionId,
      workingDirectory: workspace,
    });
    const snapshot = await seed.snapshot();
    await seed.close({ reason: "simulate reconnect" });
    const dataRoot = join(root, normalizedSessionId, "data");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "fake-pending-question.json"), JSON.stringify({
      id: "question-native-1",
      sessionID: "ses_fake_1",
      questions: [{
        id: "environment",
        header: "Environment",
        question: "Where should we deploy?",
        options: [{ label: "Staging" }, { label: "Production" }],
        custom: true,
      }],
    }));

    const recovered = await driver.recoverSession?.({
      ...snapshot,
      activeTurnId: "turn-recovered-question",
    });
    expect(recovered).toMatchObject({ recovered: true });
    const session = recovered!.session!;
    const iterator = session.events()[Symbol.asyncIterator]();
    let created: Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
    for (let count = 0; count < 20; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.eventType === "runtime_request.created") {
        created = next.value;
        break;
      }
    }
    expect(created).toMatchObject({
      payload: { request: { requestId: "question-native-1", type: "input" } },
    });
    await session.resolveRuntimeRequest?.({
      requestId: "question-native-1",
      turnId: "turn-recovered-question",
      resolution: { action: "decline" },
    });
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    await session.close({ reason: "recovery test complete" });
  });

  it.each([
    { style: "legacy", action: "accept" as const, reply: "once" },
    { style: "v2", action: "accept_for_session" as const, reply: "always" },
    { style: "v2", action: "decline" as const, reply: "reject" },
  ])("normalizes $style permission events and maps $action to $reply", async ({ style, action, reply }) => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), `paperclip-opencode-permission-${style}-`));
    const workspace = await mkdtemp(join(tmpdir(), `paperclip-opencode-permission-${style}-workspace-`));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      permissionMode: "ask",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const normalizedSessionId = `native-permission-${style}-${action}`;
    const session = await driver.openSession({
      runId: `run-${normalizedSessionId}`,
      normalizedSessionId,
      workingDirectory: workspace,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: `native-permission-${style}` },
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    let created: Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
    for (let count = 0; count < 30; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.eventType === "runtime_request.created") {
        created = next.value;
        break;
      }
    }
    expect(created).toMatchObject({
      payload: {
        request: {
          requestId: "permission-native-1",
          type: "permission",
          actions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      },
    });
    await session.resolveRuntimeRequest?.({
      requestId: "permission-native-1",
      turnId,
      resolution: { action },
    });
    const persisted = JSON.parse(
      await readFile(join(root, normalizedSessionId, "data", "fake-permission-reply.json"), "utf8"),
    );
    expect(persisted).toEqual({
      url: expect.stringContaining(`directory=${encodeURIComponent(workspace)}`),
      body: { reply },
    });
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    await session.close({ reason: "permission test complete" });
  });

  it.each(["allow", "ask", "deny"] as const)("pins the %s permission mode while retaining external-directory denial", async (permissionMode) => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), `paperclip-opencode-mode-${permissionMode}-`));
    const workspace = await mkdtemp(join(tmpdir(), `paperclip-opencode-mode-${permissionMode}-workspace-`));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      permissionMode,
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({ runId: `run-${permissionMode}`, normalizedSessionId: permissionMode, workingDirectory: workspace });
    const config = JSON.parse(await readFile(join(root, permissionMode, "config", "opencode", "opencode.json"), "utf8"));
    expect(config.permission).toMatchObject({ "*": permissionMode, external_directory: "deny" });
    expect(config.permission.paperclip_finish).toBeUndefined();
    expect(config.permission["paperclip_*"]).toBe("allow");
    await session.close({ reason: "permission mode test complete" });
  });

  it("clears a stale active turn that already has a persisted terminal fingerprint", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-stale-turn-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-stale-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const seed = await driver.openSession({
      runId: "run-stale-turn",
      normalizedSessionId: "stale-turn",
      workingDirectory: workspace,
    });
    const snapshot = await seed.snapshot();
    await seed.close({ reason: "seed complete" });

    const recoveryDriver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const recovery = await recoveryDriver.recoverSession?.({
      ...snapshot,
      activeTurnId: "turn-already-terminal",
      terminalTurns: [{ turnId: "turn-already-terminal", fingerprint: "terminal-fingerprint" }],
    });
    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery!.session!.snapshot()).resolves.toMatchObject({ activeTurnId: null });
    await recovery!.session!.close({ reason: "recovery-test" });
  });

  it("validates provider/model form", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    roots.push(root);
    const driver = new OpenCodeServerDriver({ model: "bad", runtimeDirectory: root });
    await expect(driver.validateConfig?.({ model: "bad" })).resolves.toMatchObject({ ok: false });
    await expect(driver.validateConfig?.({ model: "openrouter/model" })).resolves.toMatchObject({ ok: true });
  });

  it("normalizes a structured block result", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({ runId: "run-block", normalizedSessionId: "block", workingDirectory: workspace });
    await session.startTurn({ message: { role: "user", text: "block-result" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.find((event) => event.eventType === "run.result.proposed")?.payload)
      .toMatchObject({ reportedWorkDisposition: "blocked", blocker: { reasonCode: "test_dependency" } });
    await session.close({ reason: "test" });
  });

  it("designates the substantive pre-finish response instead of a trailing acknowledgement", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({
      runId: "run-final-selection",
      normalizedSessionId: "final-selection",
      workingDirectory: workspace,
    });
    await session.startTurn({ message: { role: "user", text: "text-before-finish" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    const finalMessages = events.filter(
      (event) => event.eventType === "item.completed"
        && event.payload.kind === "agentMessage"
        && event.payload.channel === "final",
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.payload.text).toBe("Substantive answer before finish.");
    expect(events.filter((event) => event.eventType === "item.delta").map((event) => event.payload.text))
      .toEqual(expect.arrayContaining(["Substantive answer before finish.", "Done."]));
    await session.close({ reason: "test" });
  });

  it("does not promote opening commentary to the final response when work follows it", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({
      runId: "run-commentary-only",
      normalizedSessionId: "commentary-only",
      workingDirectory: workspace,
    });
    await session.startTurn({ message: { role: "user", text: "commentary-only-before-work" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.filter(
      (event) => event.eventType === "item.completed"
        && event.payload.kind === "agentMessage"
        && event.payload.channel === "final",
    )).toHaveLength(0);
    expect(events.filter((event) => event.eventType === "item.delta").map((event) => event.payload.text))
      .toContain("I will inspect the workspace first.");
    expect(events).toContainEqual(expect.objectContaining({ eventType: "run.result.proposed" }));
    await session.close({ reason: "test" });
  });

  it("correlates the final response to the native message containing the semantic tool", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({
      runId: "run-correlated-final-selection",
      normalizedSessionId: "correlated-final-selection",
      workingDirectory: workspace,
    });
    await session.startTurn({ message: { role: "user", text: "correlated-final-message" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    const finalMessages = events.filter(
      (event) => event.eventType === "item.completed"
        && event.payload.kind === "agentMessage"
        && event.payload.channel === "final",
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.payload.text).toBe("Correlated substantive final answer.");
    expect(events.filter((event) => event.eventType === "item.delta").map((event) => event.payload.text))
      .toEqual(expect.arrayContaining([
        "I will write the result now.",
        "Correlated substantive final answer.",
        "Done.",
      ]));
    await session.close({ reason: "test" });
  });

  it("prefers a substantive post-tool answer over schema commentary in the tool message", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({
      runId: "run-post-tool-final-selection",
      normalizedSessionId: "post-tool-final-selection",
      workingDirectory: workspace,
    });
    await session.startTurn({ message: { role: "user", text: "final-after-tool-commentary" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    const finalMessages = events.filter(
      (event) => event.eventType === "item.completed"
        && event.payload.kind === "agentMessage"
        && event.payload.channel === "final",
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.payload.text)
      .toBe("This is the complete substantive answer emitted after the accepted completion tool call.");
    await session.close({ reason: "test" });
  });

  it("rejects malformed and oversized SSE frames", async () => {
    const stream = (value: string) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    });
    const consume = async (value: string) => {
      for await (const _event of openCodeServerDriverInternals.parseSse(stream(value))) {
        // Consume the complete stream so parse failures are observed.
      }
    };
    await expect(consume("data: {bad json}\n\n")).rejects.toThrow();
    await expect(consume(`data: ${"x".repeat(1_048_577)}`)).rejects.toThrow("payload limit");
  });

  it("restarts OpenCode when session startup fails transiently", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    let failSessionCreate = true;
    const spawns: number[] = [];
    const commandLifecycle: string[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      commandLifecycle: {
        beforeSpawn: () => { commandLifecycle.push("before"); },
        afterSpawn: () => { commandLifecycle.push("after"); },
      },
      fetch: async (input, init) => {
        if (failSessionCreate && String(input).endsWith("/session") && init?.method === "POST") {
          failSessionCreate = false;
          throw new Error("transient session initialization failure");
        }
        return fetch(input, init);
      },
      onSpawn: async ({ pid }) => { spawns.push(pid); },
    });
    const session = await driver.openSession({ runId: "run-retry", normalizedSessionId: "retry", workingDirectory: workspace });
    expect(session.ids().providerSessionId).toBe("ses_fake_1");
    expect(spawns).toHaveLength(2);
    expect(commandLifecycle).toEqual(["before", "after", "before", "after"]);
    await session.close({ reason: "test" });
  });

  it("reports startup exit details with stderr captured after spawn and redacted", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const exitingFixture = join(root, "exit-before-health.mjs");
    await writeFile(
      exitingFixture,
      "#!/usr/bin/env node\nprocess.stderr.write(`credential=${process.env.OPENROUTER_API_KEY}\\nauthorization=super-secret-opencode-token\\n`);\nprocess.exit(17);\n",
      { mode: 0o755 },
    );
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: exitingFixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const error = await driver.openSession({
      runId: "run-startup-exit",
      normalizedSessionId: "startup-exit",
      workingDirectory: workspace,
    }).then(
      () => "provider unexpectedly started",
      (cause: unknown) => String(cause),
    );
    expect(error).toContain("provider_process_exited");
    expect(error).toContain("provider=opencode");
    expect(error).toContain("stage=health");
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain("fixture-key");
    expect(error).not.toContain("super-secret-opencode-token");
  });
});

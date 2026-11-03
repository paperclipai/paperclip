import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { HarnessReleaseIdentity, RunnerHarnessCheckpoint } from "@paperclipai/runner-sdk/contracts";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary, probeNativeRunnerEnvironment, runnerdRecoveryInternals } from "./runnerd-codex-transport.js";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import { parseNativeExecutionInput, type NativeExecutionInputV11 } from "../contracts/native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest, nativeRuntimePromptDigest } from "../contracts/runtime-context.js";

const runnerBinary = process.env.PAPERCLIP_EXTENSION_TEST_RUNNERD ?? defaultCapabilityRunnerdBinary();
const digest = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(mode: "complete" | "hold" | "requests" | "plan" | "core-completion-only" = "complete") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-native-extension-")));
  const source = await realpath(process.execPath);
  const command = join(root, "node");
  await copyFile(source, command); await chmod(command, 0o500);
  if (process.platform === "darwin") {
    const lib = join(dirname(dirname(source)), "lib");
    for (const name of await readdir(lib)) if (name.startsWith("libnode.") && name.endsWith(".dylib")) {
      await copyFile(join(lib, name), join(root, name)); await chmod(join(root, name), 0o400);
    }
  }
  const entrypoint = join(root, "harness.cjs");
  await copyFile(new URL("./fixtures/native-extension.cjs", import.meta.url), entrypoint); await chmod(entrypoint, 0o400);
  const identity: HarnessReleaseIdentity = { harnessId: "fixture.native/independent", packageName: "@fixture/plugin-native", version: "1.0.0",
    protocolVersion: 1, integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, runtimeDigest: digest(await readFile(entrypoint)) };
  const profile = { schema: "paperclip.harness-launch.v1", identity,
    command: { path: command, sha256: digest(await readFile(command)) },
    entrypoint: { path: entrypoint, sha256: digest(await readFile(entrypoint)) }, args: [], environmentKeys: [] };
  const provider = { kind: "extension" as const, harnessId: identity.harnessId, release: identity, model: "fixture-exact-model",
    config: { mode, pidPath: join(root, "provider.pid"), outputPath: join(root, "output.json") },
    capabilities: { resume: true, typedEvents: true, interruption: true, structuredResult: true, dynamicTools: true, usage: mode === "core-completion-only",
      ...(mode === "requests" ? { runtimeRequestResolution: true } : {}), ...(mode === "plan" ? { planning: true } : {}) } };
  const assetDigest = "0".repeat(64);
  await writeFile(join(root, "AGENTS.md"), "Follow the assigned fixture instructions.");
  const context = { prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, rootPath: root, digest: assetDigest, manifestDigest: assetDigest, fileCount: 1, totalBytes: 42 } },
    skills: [], mcp: { assignmentSetId: "none", digest: assetDigest, bindingId: null } };
  const input = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v11", homeMode: "isolated", provider,
    binding: { companyId: "fixture_company", agentId: "fixture_agent", issueId: "fixture_issue", runId: "fixture_run", executionWorkspaceId: "fixture_workspace" },
    task: { identifier: "FIX-1", title: "Exercise independent native harness", description: null, prompt: "Produce the fixture file", workMode: mode === "plan" ? "planning" : "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: "fixture_session", driverKind: "extension", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    completionContract: { id: "fixture_contract", sha256: "fixture-digest", schemaVersion: "1",
      contract: { revision: "1", objective: "Produce the fixture file", criteria: [{ id: "objective", requirement: "A file contains the controller-supplied value" }] } },
    interactionResponses: [], credentialBindings: [], executionMode: mode === "plan" ? "plan" : "default",
    planningContext: mode === "plan" ? { documentId: null, baseRevisionId: null, baseRevisionNumber: 0, markdown: "", sha256: "empty", reviewContext: {} } : null,
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
  }) as NativeExecutionInputV11;
  const bundles: ReturnType<typeof createCapabilityRunnerdCodexTransport>[] = [];
  const createBundle = (checkpoint?: RunnerHarnessCheckpoint, runId = input.binding.runId) => {
  const bundle = createCapabilityRunnerdCodexTransport({ provider: "extension", extensionRelease: identity,
    extensionConfig: provider.config, extensionCapabilities: provider.capabilities, extensionLaunchProfile: profile,
    extensionCheckpoint: checkpoint,
    runnerBinary, stateDirectory: join(root, runId), sourceCodexHome: "", environment: {},
    prpIdentity: { runnerInstanceId: `fixture_runner_${runId}`, environmentLeaseId: "fixture_lease", runId,
      normalizedSessionId: "fixture_session", turnId: `fixture_turn_${runId}`, itemId: `fixture_item_${runId}` },
    turnStartTimeoutMs: 5_000,
  });
  bundles.push(bundle);
  return bundle;
  };
  const bundle = createBundle();
  return { root, input, bundle, bundles, createBundle, profile };
}

it("does not treat an idle extension as physically settled while its process group remains", () => {
  const inspect = runnerdRecoveryInternals.providerDrainStateFromSnapshot;
  const state = { schema: "paperclip.harness-state.v1", events: [], activeTurn: false,
    turnId: "fixture_turn", processGroup: 123, pendingRequests: {} };
  expect(inspect(state)).toMatchObject({ providerSettled: false, activeProviderTurnId: null });
  expect(inspect({ ...state, processGroup: null })).toMatchObject({ providerSettled: true });
  expect(inspect({ ...state, activeTurn: true })).toMatchObject({ providerSettled: false, activeProviderTurnId: "fixture_turn" });
  expect(inspect({ ...state, processGroup: null, pendingRequests: { waiting: {} } })).toMatchObject({ providerSettled: false });
  expect(() => inspect({ ...state, processGroup: "unproven" })).toThrow("malformed");
});

it("verifies the installed native extension model with a real read-only admission probe", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "admission"), { mode: 0o700 });
    const result = await probeNativeRunnerEnvironment({ provider: "extension", model: f.input.provider.model,
      admissionOnly: true, runtimeDirectory: join(f.root, "admission"), environment: {}, timeoutMs: 10_000,
      transportOptions: { runnerBinary, sourceCodexHome: "", extensionRelease: f.input.provider.release,
        extensionConfig: f.input.provider.config, extensionCapabilities: f.input.provider.capabilities, extensionLaunchProfile: f.profile,
        prpIdentity: { runnerInstanceId: "probe_fixture_runner", environmentLeaseId: "probe_fixture_lease", runId: "probe_fixture_run",
          normalizedSessionId: "probe_fixture_session", turnId: "probe_fixture_turn", itemId: "probe_fixture_item" } },
    });
    expect(result).toMatchObject({ provider: "extension", providerDriver: "extension", effectiveModel: "fixture-exact-model",
      admissionOnly: true, sessionAdmissionPassed: true });
    const pid = Number(await readFile(join(f.root, "provider.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    for (const bundle of f.bundles) await bundle.transport.close().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

it("runs an independent harness through real runnerd, semantic tool replies and the native backend", async () => {
  const f = await fixture();
  const nonce = randomUUID();
  const calls: string[] = [];
  const backend = createRunnerdNativeSessionBackend(f.input, {
    retainedSystemInstructions: "Pinned instructions for the native harness",
    dynamicTools: [{ name: "get_fixture_value", description: "Read the unpredictable fixture value", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    dynamicToolHandler: async call => { calls.push(call.tool); return { value: nonce }; },
    transportFactory: () => f.bundle.transport,
  });
  try {
    const session = await backend.openSession({ identity: { runId: f.input.binding.runId, sessionId: "fixture_session",
      companyId: f.input.binding.companyId, agentId: f.input.binding.agentId, issueId: f.input.binding.issueId }, workingDirectory: f.root });
    expect(await session.capabilities()).toMatchObject({ resume: true, typedEvents: true, structuredResult: true,
      interruption: true, dynamicTools: true, steering: false, read: false, usage: false, goals: false });
    await session.startTurn({ message: { role: "user", text: "Run the independent harness fixture." } });
    const eventTypes: string[] = [];
    for await (const event of session.events()) {
      eventTypes.push(event.eventType);
      if (event.eventType === "turn.completed") break;
    }
    const result = await session.result();
    expect(result?.result.reportedWorkDisposition).toBe("done");
    expect(calls).toEqual(["get_fixture_value"]);
    expect(await readFile(join(f.root, "output.json"), "utf8")).toContain(nonce);
    expect(eventTypes).toContain("turn.started");
    expect(eventTypes).toContain("turn.completed");
    const checkpoint = await session.snapshot();
    expect(checkpoint.extensionCheckpoint).toMatchObject({ identity: f.input.provider.release,
      normalizedSessionId: "fixture_session", model: "fixture-exact-model", providerState: { turns: 1 } });
    await session.close({ reason: "fixture complete" }).catch(error => {
      throw new Error(`Extension close failed: ${JSON.stringify({ settlement: error.settlement, evidence: f.bundle.evidence() })}`, { cause: error });
    });
    const pid = Number(await readFile(join(f.root, "provider.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();

    const resumedInput = { ...f.input, binding: { ...f.input.binding, runId: "fixture_run_2" } };
    const resumedNonce = randomUUID();
    const resumedBackend = createRunnerdNativeSessionBackend(resumedInput, {
      retainedSystemInstructions: "Current pinned instructions for the resumed native harness",
      dynamicTools: [{ name: "get_fixture_value", description: "Read the current unpredictable fixture value", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      dynamicToolHandler: async () => ({ value: resumedNonce }),
      transportFactory: context => f.createBundle(context?.persistedSession?.extensionCheckpoint, resumedInput.binding.runId).transport,
    });
    const resumed = await resumedBackend.recoverSession!(checkpoint, { signal: new AbortController().signal });
    expect(resumed.recovered).toBe(true);
    const resumedSession = resumed.session!;
    expect(resumedSession.identity().runId).toBe("fixture_run_2");
    const restored = await resumedSession.snapshot();
    expect(restored.sessionId).toBe(checkpoint.sessionId);
    expect(restored.providerSessionId).toBe(checkpoint.providerSessionId);
    expect(restored.extensionCheckpoint?.providerState).toEqual(checkpoint.extensionCheckpoint?.providerState);
    await resumedSession.startTurn({ message: { role: "user", text: "Continue the existing native conversation." }, continuation: true });
    for await (const event of resumedSession.events()) if (event.eventType === "turn.completed") break;
    expect((await resumedSession.result())?.result.reportedWorkDisposition).toBe("done");
    const output = await readFile(join(f.root, "output.json"), "utf8");
    expect(output).toContain(resumedNonce);
    expect(JSON.parse(output).turns).toBe(2);
    const nextCheckpoint = await resumedSession.snapshot();
    await resumedSession.close({ reason: "continuation fixture complete" });
    const resumedPid = Number(await readFile(join(f.root, "provider.pid"), "utf8"));
    expect(resumedPid).not.toBe(pid);
    expect(() => process.kill(resumedPid, 0)).toThrow();

    const mismatchBackend = createRunnerdNativeSessionBackend({ ...f.input, binding: { ...f.input.binding, runId: "fixture_run_3" } }, {
      transportFactory: context => f.createBundle(context?.persistedSession?.extensionCheckpoint, "fixture_run_3").transport,
    });
    const mismatch = await mismatchBackend.recoverSession!({ ...nextCheckpoint, providerSessionId: "unrelated-native-session" }, { signal: new AbortController().signal });
    expect(mismatch).toMatchObject({ recovered: false, reason: "extension checkpoint restored a different native conversation" });
    const rejectedPid = Number(await readFile(join(f.root, "provider.pid"), "utf8"));
    expect(() => process.kill(rejectedPid, 0)).toThrow();
  } finally {
    for (const bundle of f.bundles) await bundle.transport.close().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
}, 60_000);

it("settles Core-owned completion without a duplicate provider proposal and drains later usage", async () => {
  const f = await fixture("core-completion-only");
  const backend = createRunnerdNativeSessionBackend(f.input, {
    retainedSystemInstructions: "Follow the assigned fixture instructions",
    dynamicTools: [{ name: "get_fixture_value", description: "Read the fixture value", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    dynamicToolHandler: async () => ({ value: "supplied by the controller" }),
    transportFactory: () => f.bundle.transport,
  });
  try {
    const session = await backend.openSession({ identity: { runId: f.input.binding.runId, sessionId: "fixture_session",
      companyId: f.input.binding.companyId, agentId: f.input.binding.agentId, issueId: f.input.binding.issueId }, workingDirectory: f.root });
    await session.startTurn({ message: { role: "user", text: "Complete through the controller, then return the final native answer." } });
    const events = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.eventType === "turn.completed") break;
    }
    const proposals = events.filter(event => event.eventType === "run.result.proposed");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.payload).toMatchObject({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done" });
    expect(events.some(event => event.eventType === "item.completed" && event.payload.kind === "usage"
      && (event.payload.usage as { runDelta?: { requests?: number } }).runDelta?.requests === 5)).toBe(true);
    expect(events.some(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage"
      && event.payload.text === "Independent harness produced the verified file.")).toBe(true);
    const result = await session.result();
    expect(result?.result.reportedWorkDisposition).toBe("done");
    expect(result?.terminal).toMatchObject({ turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" });
    const checkpoint = await session.snapshot();
    expect(checkpoint.extensionCheckpoint?.providerState).toMatchObject({ turns: 1 });
    expect(checkpoint.terminal?.reportedWorkDisposition).toBe("done");
    await session.close({ reason: "fixture complete" });
    const pid = Number(await readFile(join(f.root, "provider.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    for (const bundle of f.bundles) await bundle.transport.close().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

it("revokes a live extension turn on Stop and physically reaps its native process", async () => {
  const f = await fixture("hold");
  const backend = createRunnerdNativeSessionBackend(f.input, {
    retainedSystemInstructions: "Pinned instructions for cancellation",
    transportFactory: () => f.bundle.transport,
  });
  try {
    const session = await backend.openSession({ identity: { runId: f.input.binding.runId, sessionId: "fixture_session",
      companyId: f.input.binding.companyId, agentId: f.input.binding.agentId, issueId: f.input.binding.issueId }, workingDirectory: f.root });
    await session.startTurn({ message: { role: "user", text: "Keep pending work alive for Stop." } });
    const activeSnapshot = await session.snapshot();
    expect(activeSnapshot.activeTurnId).not.toBeNull();
    expect(activeSnapshot.extensionCheckpoint).toBeUndefined();
    expect(await session.result()).toBeNull();
    const pid = Number(await readFile(join(f.root, "provider.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    const cancellation = session.cancel!({ reason: "operator_stop", signal: new AbortController().signal });
    await expect(session.startTurn({ message: { role: "user", text: "Late work must not start" } })).rejects.toThrow("cancelled");
    await cancellation.cleanup;
    await session.close({ reason: "operator_stop" });
    expect(await session.result()).toBeNull();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.bundle.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
  } finally {
    await f.bundle.transport.close().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

it("round-trips canonical native questions and command/file approvals without another provider's origin", async () => {
  const f = await fixture("requests");
  const backend = createRunnerdNativeSessionBackend(f.input, { transportFactory: () => f.bundle.transport });
  try {
    const session = await backend.openSession({ identity: { runId: f.input.binding.runId, sessionId: "fixture_session",
      companyId: f.input.binding.companyId, agentId: f.input.binding.agentId, issueId: f.input.binding.issueId }, workingDirectory: f.root });
    await session.startTurn({ message: { role: "user", text: "Ask and resolve the native fixture requests." } });
    const observed: string[] = [];
    for await (const event of session.events()) {
      if (event.eventType === "runtime_request.created") {
        const request = event.payload.request as { requestId: string; requestKind: string };
        observed.push(request.requestId);
        await session.resolveRuntimeRequest!({ requestId: request.requestId, turnId: event.turnId!,
          resolution: request.requestId === "fixture-question"
            ? { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { answer: { text: "controller-approved-value" } } } }
            : { action: "accept" } });
      }
      if (event.eventType === "turn.completed") break;
    }
    expect(observed).toEqual(["fixture-question", "fixture-approval", "fixture-file-approval"]);
    const replies = (await readFile(join(f.root, "output.json"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0]).toMatchObject({ requestId: "fixture-question", response: { answers: { answer: { text: "controller-approved-value" } } } });
    expect(replies.slice(1)).toMatchObject([{ requestId: "fixture-approval", resolution: { action: "accept" } },
      { requestId: "fixture-file-approval", resolution: { action: "accept" } }]);
    await session.close({ reason: "native request fixture complete" });
  } finally {
    for (const bundle of f.bundles) await bundle.transport.close().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

it("negotiates an admitted native planning capability through the shared facade", async () => {
  const f = await fixture("plan");
  const backend = createRunnerdNativeSessionBackend(f.input, { transportFactory: () => f.bundle.transport });
  try {
    const session = await backend.openSession({ identity: { runId: f.input.binding.runId, sessionId: "fixture_session",
      companyId: f.input.binding.companyId, agentId: f.input.binding.agentId, issueId: f.input.binding.issueId }, workingDirectory: f.root });
    expect((await session.capabilities()).collaborationModes).toEqual(["default", "plan"]);
    const turn = await session.startTurn({ message: { role: "user", text: "Produce the native plan." }, requestedCollaborationMode: "plan" });
    expect(turn.effectiveCollaborationMode).toBe("plan");
    const events: string[] = [];
    for await (const event of session.events()) {
      events.push(event.eventType);
      if (event.eventType === "turn.completed") break;
    }
    expect(events).toContain("item.completed");
    await session.close({ reason: "native planning fixture complete" });
  } finally {
    for (const bundle of f.bundles) await bundle.transport.close().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

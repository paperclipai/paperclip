import { CodexAppServerDriver, FakeCodexTransport, WORKSPACE, collectUntilTerminal, envelope, expect, it, vi, type CodexAppServerTransport } from "./codex-app-server-driver.test-support.js";

const model = "gemini-3.8-flash-low";
const identity = { kind: "acpx", normalizedSessionId: "native-conversation", acpxRecordId: "record-1", backendSessionId: "backend-1", agentSessionId: "native-1",
  profileDigest: `sha256:${"a".repeat(64)}`, workspaceDigest: `sha256:${"b".repeat(64)}`, requestedModel: model, effectiveModel: model,
  permissionMode: "approve-all", providerLifetimeFenceCandidates: [60001, 60002, 60003] };

function peer(nativeIdentity = identity) {
  const transport = new FakeCodexTransport("driver-1", "native-1", nativeIdentity) as FakeCodexTransport & Pick<CodexAppServerTransport, "prepareConversationResume">;
  const request = transport.request.bind(transport);
  transport.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "thread/start" || method === "thread/resume") result.model = model;
    return result;
  };
  transport.readResponse = { thread: { id: "driver-1", sessionId: "native-1", cwd: WORKSPACE, turns: [] } };
  return transport;
}

it.each(["loaded", "missing-conversation", "different-thread", "different-native-identity"])("normal driver continuation prepares a fresh lifetime before authoritative reads (%s)", async mode => {
  const first = peer(), next = peer(mode === "different-native-identity" ? { ...identity, agentSessionId: "replaced-native-session" } : identity);
  const instructions = "Current assigned instruction bytes.\n";
  const prepare = vi.fn(async (params: Record<string, unknown>) => {
    next.calls.push({ method: "owned-conversation-bootstrap", params: structuredClone(params) });
    expect(next.calls.some(call => call.method === "thread/read")).toBe(false);
    if (mode === "missing-conversation") throw new Error("retained native conversation is unavailable");
    if (mode === "different-thread") next.readResponse = { thread: { id: "different-driver", sessionId: "different-native", cwd: WORKSPACE, turns: [] } };
  });
  next.prepareConversationResume = prepare;
  let index = 0;
  const driver = new CodexAppServerDriver({ taskEnvelope: envelope, model, baseInstructions: instructions,
    requireProviderSessionIdentity: true, driverIdentity: { kind: "acpx", displayName: "Antigravity", version: "test" }, requestedCollaborationMode: "default", environment: {}, transportFactory: () => [first, next][index++]! });
  const original = await driver.openSession({ runId: "first-run", normalizedSessionId: "native-conversation", workingDirectory: WORKSPACE });
  await original.startTurn({ message: { role: "user", text: "Finish the first turn." } });
  first.push("turn/completed", { threadId: "driver-1", turn: { id: "turn-1", status: "completed", items: [] } });
  await collectUntilTerminal(original.events());
  const snapshot = await original.snapshot();
  expect(snapshot.activeTurnId).toBeNull();
  await original.close({ reason: "first per-turn lifetime retired" });
  snapshot.runId = "current-run";
  snapshot.providerRecoveryPolicy = "same_session_only";
  next.turnStartResponse = Promise.resolve({ turn: { id: "turn-2", status: "inProgress", items: [] } });
  const recovered = await driver.recoverSession(snapshot);
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ threadId: "driver-1", model, cwd: WORKSPACE, approvalPolicy: "never", permissions: "paperclip-runner-workspace-only", dynamicTools: expect.any(Array) }));
  expect(prepare.mock.calls[0]![0].baseInstructions).toContain(instructions.trim());
  if (mode === "loaded") {
    expect(recovered.recovered).toBe(true);
    expect(next.calls.find(call => call.method === "thread/resume")!.params).toEqual(prepare.mock.calls[0]![0]);
    expect((await recovered.session!.snapshot()).providerIdentity).toEqual(identity);
    await recovered.session!.startTurn({ message: { role: "user", text: "Continue in the retained conversation." } });
    expect(next.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    await recovered.session!.close({ reason: "current per-turn lifetime retired" });
  } else {
    expect(recovered.recovered).toBe(false);
    expect(next.calls.some(call => call.method === "turn/start" || call.method === "thread/start")).toBe(false);
    if (mode === "missing-conversation") expect(next.calls.some(call => call.method === "thread/read")).toBe(false);
  }
});

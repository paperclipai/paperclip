import { describe, expect, it } from "vitest";
import { HarnessDriverBackend } from "../../../packages/paperclip-runner/src/backends/harness-driver-backend.js";
import { FakeCodexTransport, makeDriver, result, WORKSPACE } from "../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.js";
import { redactRunnerApiPayloads } from "../services/native-runtime/runner-api-log-redaction.js";

describe("private API output in provider recovery", () => {
  it.each([false, true])("compares active completion through the saved projection (changed=%s)", async changed => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const backend = new HarnessDriverBackend(makeDriver([first, second]));
    const identity = { runId: "api-recovery-run", sessionId: "api-recovery-session", companyId: "company", issueId: "issue", agentId: "agent" };
    const original = await backend.openSession({ identity, workingDirectory: WORKSPACE });
    await original.startTurn({ message: { role: "user", text: "Finish the task." } });
    const receipt = { operationId: "call_api", apiOperationId: "POST /api/companies/{companyId}/exports", callId: "export", ok: true, status: 200, data: { credential: "private-recovery-value" } };
    const completion = { ...result, summary: JSON.stringify(receipt) };
    expect(await first.invoke({ id: "finish", method: "item/tool/call", params: {
      threadId: "thread-1", turnId: "turn-1", callId: "finish", tool: "paperclip_finish", arguments: completion,
    } })).toMatchObject({ success: true });
    const raw = await original.snapshot();
    expect(raw.activeTurnId).toBe("turn-1");
    expect(raw.semanticResult).toEqual(completion);
    const checkpoint = redactRunnerApiPayloads(raw);
    expect(JSON.stringify(checkpoint)).not.toContain("private-recovery-value");
    expect(JSON.stringify(checkpoint)).toContain("apiPayloadSha256");
    await original.close({ reason: "simulate restart before the terminal checkpoint" });
    const providerResult = changed ? { ...completion, summary: JSON.stringify({ ...receipt, data: { credential: "changed-value" } }) } : completion;
    second.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE,
      turns: [{ id: "turn-1", status: "completed", items: [{ id: "finish", type: "agentMessage", text: JSON.stringify(providerResult) }] }],
    } };
    const recovered = await backend.recoverSession(checkpoint, {
      signal: new AbortController().signal, normalizeReplayPayload: redactRunnerApiPayloads,
    });
    if (changed) {
      expect(recovered).toMatchObject({ recovered: false, reason: expect.stringContaining("conflicting") });
    } else {
      expect(recovered.recovered).toBe(true);
      expect((await recovered.session!.snapshot()).semanticResult).toEqual(checkpoint.semanticResult);
      await recovered.session!.close({ reason: "verified recovery" });
    }
    expect(second.calls.some(call => call.method === "turn/start")).toBe(false);
  });
});

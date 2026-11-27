import { describe, expect, it, vi } from "vitest";
import { createWakeRecoveryDeferral } from "./recovery-deferral.js";

const condition = { recoveryActionId: "action", reason: "execution_recovery", message: "Waiting for recovery." };
const request = {
  agentId: "agent", source: "assignment", triggerDetail: "system", reason: "issue_commented",
  payload: { issueId: "other" }, requestedByActorType: "user", requestedByActorId: "user",
  idempotencyKey: "user-wake",
};
const input = { request, condition, contextSnapshot: { wakeCommentIds: ["previous", "comment"] },
  nextAction: "Inspect recovery.", coalesce: false, publications: [] };

function fixture() {
  const store = { updateWait: vi.fn(), insertDeferred: vi.fn(), recordWait: vi.fn() };
  return { ...store, defer: createWakeRecoveryDeferral("issue", false, store) };
}

describe("wake recovery deferral", () => {
  it("saves a scoped comment receipt before confirming admission", async () => {
    const f = fixture();
    f.insertDeferred.mockRejectedValueOnce(new Error("save failed"));
    await expect(f.defer({ ...input, commentId: "comment" })).rejects.toThrow("save failed");
    await expect(f.defer({ ...input, commentId: "comment" })).resolves.toEqual({ kind: "deferred", admitted: true });
    expect(f.insertDeferred).toHaveBeenLastCalledWith({ ...request, payload: {
      issueId: "issue", commentId: "comment", executionWait: condition,
      _paperclipWakeContext: { wakeCommentIds: ["previous", "comment"], wakeCommentId: "comment", commentId: "comment" },
    } });
    expect(f.recordWait).not.toHaveBeenCalled();
  });

  it.each([false, true])("updates a requested receipt without replacing it (saved: %s)", async saved => {
    const f = fixture();
    f.updateWait.mockResolvedValue(saved);
    await expect(f.defer({ ...input, existingRequestId: "existing", commentId: "comment" })).resolves.toEqual(
      saved ? { kind: "deferred", admitted: true } : { kind: "deferred" },
    );
    expect(f.updateWait).toHaveBeenCalledExactlyOnceWith({ requestId: "existing", agentId: request.agentId, condition, publications: [] });
    expect(f.insertDeferred).not.toHaveBeenCalled();
    expect(f.recordWait).not.toHaveBeenCalled();
  });

  it("records a diagnostic for a blocked signal without saved work", async () => {
    const f = fixture();
    await expect(f.defer({ ...input, contextSnapshot: {}, coalesce: true })).resolves.toEqual({ kind: "deferred", admitted: true });
    expect(f.recordWait).toHaveBeenCalledExactlyOnceWith({ request, condition, nextAction: input.nextAction, coalesce: true });
    expect(f.insertDeferred).not.toHaveBeenCalled();
  });
});

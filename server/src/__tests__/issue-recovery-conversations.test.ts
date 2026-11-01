import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { heartbeatRuns, issues, issueComments } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { undeliveredConversationComments } from "../services/agent-conversations.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { issueService } from "../services/issues.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("issue recovery production producers and conversations", () => {
  const state = issueRecoveryFixture();
  const { quiet, completed, savedConversation } = state;
  it("dispatches a saved conversation only from the committed Agent Chat enable transition", async () => {
    const f = await savedConversation();
    expect(await undeliveredConversationComments(state.db, f.companyId, f.chat.id)).toHaveLength(1);
    await f.settings.updateExperimental({ enableAgentChat: true });
    expect(state.coordinator.nextWakeAt()).not.toBeNull();
    await vi.waitFor(async () => expect(await state.db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1), { timeout: 40_000 });
    const run = await completed(f.chat.id);
    expect(f.replies).toEqual([run.id]); expect(f.failures).toEqual([]);
    expect(await undeliveredConversationComments(state.db, f.companyId, f.chat.id)).toEqual([]);
    expect((await state.db.select().from(issues).where(eq(issues.id, f.chat.id)))[0])
      .toMatchObject({ conversationState: "waiting", executionRunId: null });
    expect(await state.db.select().from(issueComments).where(and(eq(issueComments.createdByRunId, run.id),
      eq(issueComments.authorAgentId, f.agentId)))).toHaveLength(1);
    await quiet();
    let hints = 0;
    const stop = subscribeDeliveryWork(state.db, DELIVERY_QUEUES.strandedAssignments, () => { hints++; });
    try { await f.settings.updateExperimental({ enableAgentChat: true }); expect(hints).toBe(0); await quiet(); }
    finally { stop(); }
    expect(f.replies).toEqual([run.id]);
  });
  it("keeps disabled saved conversations parked after rollback, unrelated flags and unchanged values", async () => {
    const f = await savedConversation();
    await expect(state.db.transaction(async tx => {
      await instanceSettingsService(tx as unknown as typeof state.db).updateExperimental({ enableAgentChat: true });
      throw new Error("chat flag rollback");
    })).rejects.toThrow("chat flag rollback");
    await quiet();
    expect((await f.settings.getExperimental()).enableAgentChat).toBe(false);
    let hints = 0;
    const stop = subscribeDeliveryWork(state.db, DELIVERY_QUEUES.strandedAssignments, () => { hints++; });
    try {
      await f.settings.updateExperimental({ enableConferenceRoomChat: true });
      await f.settings.updateExperimental({ enableAgentChat: false });
      expect(hints).toBe(0); await quiet();
    } finally { stop(); }
    expect(f.replies).toEqual([]); expect(f.failures).toEqual([]);
    expect(await state.db.select().from(heartbeatRuns)).toEqual([]);
    expect(await undeliveredConversationComments(state.db, f.companyId, f.chat.id)).toHaveLength(1);
  });
  it("does not dispatch an accepted saved message after Agent Chat is disabled", async () => {
    const f = await savedConversation(false);
    await f.settings.updateExperimental({ enableAgentChat: true }); await quiet();
    state.draining = true;
    await issueService(state.db).addComment(f.chat.id, "Retain while disabled", { userId: "recovery-user" }, { clientRequestId: randomUUID() });
    let hints = 0;
    const stop = subscribeDeliveryWork(state.db, DELIVERY_QUEUES.strandedAssignments, () => { hints++; });
    try { await f.settings.updateExperimental({ enableAgentChat: false }); expect(hints).toBe(0); }
    finally { stop(); }
    state.draining = false; await quiet();
    expect(f.replies).toEqual([]); expect(f.failures).toEqual([]);
    expect(await state.db.select().from(heartbeatRuns)).toEqual([]);
    expect(await undeliveredConversationComments(state.db, f.companyId, f.chat.id)).toHaveLength(1);
  });

});

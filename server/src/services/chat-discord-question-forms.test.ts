import { Modal, Select, SelectOption, TextInput } from "chat";
import { describe, expect, it } from "vitest";
import {
  deleteDiscordQuestionFormCorrection,
  discordQuestionFormCorrectionModal,
  discordQuestionFormThreadId,
  loadDiscordQuestionFormCorrection,
  retainDiscordQuestionFormCorrection,
} from "./chat-discord-question-forms.js";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
} from "./chat-sdk-state.js";

const scope = { companyId: "company", endpointId: "endpoint" };
const owner = {
  principalId: "principal",
  userId: "member",
  externalUserId: "444444444444444444",
};
const threadId =
  "discord:111111111111111111:222222222222222222:333333333333333333";
const now = new Date("2026-09-09T01:00:00Z");
const inputId = `pcff:${"I".repeat(22)}`;
const selectId = `pcff:${"S".repeat(22)}`;
const optionId = `pcfo:${"O".repeat(22)}`;
const submitActionId = `pcfs:${"A".repeat(22)}`;
function fixture() {
  const rows = new Map<string, ChatSdkStateRecord>();
  const key = (scope: { companyId: string; endpointId: string }, key: string) =>
    JSON.stringify([scope.companyId, scope.endpointId, key]);
  const persistence: ChatSdkStatePersistence = {
    async read(scope, id) {
      return rows.get(key(scope, id)) ?? null;
    },
    async compareAndSet(input) {
      const id = key(input, input.key);
      const old = rows.get(id);
      if ((old?.version ?? null) !== input.expectedVersion) return false;
      rows.set(id, {
        value: input.value,
        expiresAt: input.expiresAt,
        version: (old?.version ?? 0) + 1,
      });
      return true;
    },
    async deleteIfVersion(input) {
      const id = key(input, input.key);
      if (rows.get(id)?.version !== input.expectedVersion) return false;
      return rows.delete(id);
    },
  };
  const modal = Modal({
    callbackId: submitActionId,
    privateMetadata: submitActionId,
    title: "Details",
    children: [
      TextInput({ id: inputId, label: "Release note", maxLength: 12 }),
      Select({
        id: selectId,
        label: "Environment",
        options: [SelectOption({ label: "Staging", value: optionId })],
      }),
    ],
  });
  const input = {
    ...owner,
    conversationId: "conversation",
    publicationId: "publication",
    providerMessageId: "555555555555555555",
    threadId,
    interactionId: "interaction",
    openActionId: `pcf:${"B".repeat(22)}`,
    submitActionId,
    parentExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    modal,
    fieldErrors: { [inputId]: "Too long" },
    values: {
      [inputId]: "A very long release note",
      [selectId]: optionId,
      foreign: "never retained",
    },
  };
  return { rows, persistence, input };
}

describe("Discord actor-scoped correction drafts", () => {
  it("retains only bounded known values under one opaque actor/form key with parent TTL", async () => {
    const { persistence, rows, input } = fixture();
    const response = await retainDiscordQuestionFormCorrection(
      persistence,
      scope,
      input,
      now,
    );
    expect(response.paperclipDiscordCorrection.actionId).toMatch(
      /^pcfr:[\w-]{43}$/,
    );
    expect(response.paperclipDiscordCorrection.message).toContain(
      "Release note: Too long",
    );
    expect(response.paperclipDiscordCorrection.message).toContain(
      "shortened to 12",
    );
    expect(response.paperclipDiscordCorrection.message).not.toContain(inputId);
    const draft = await loadDiscordQuestionFormCorrection(
      persistence,
      scope,
      response.paperclipDiscordCorrection.actionId,
      owner,
      threadId,
      now,
    );
    expect(draft?.values).toEqual({
      [inputId]: "A very long ",
      [selectId]: optionId,
    });
    expect(draft?.expiresAt).toBe(input.parentExpiresAt);
    const retried = await retainDiscordQuestionFormCorrection(
      persistence,
      scope,
      { ...input, values: { [inputId]: "New note" } },
      now,
    );
    expect(retried.paperclipDiscordCorrection.actionId).toBe(
      response.paperclipDiscordCorrection.actionId,
    );
    expect(rows.size).toBe(1);
    expect(JSON.stringify([...rows])).not.toContain("foreign");
    expect(
      discordQuestionFormCorrectionModal(input.modal, draft!)?.children[0],
    ).toMatchObject({ initialValue: "A very long " });
  });

  it.each([
    "company",
    "endpoint",
    "principal",
    "member",
    "external actor",
    "thread",
    "handle",
  ])("does not expose editable values after %s mismatch", async (kind) => {
    const { persistence, input } = fixture();
    const response = await retainDiscordQuestionFormCorrection(
      persistence,
      scope,
      input,
      now,
    );
    const readScope = { ...scope };
    const readOwner = { ...owner };
    if (kind === "company") readScope.companyId = "other";
    if (kind === "endpoint") readScope.endpointId = "other";
    if (kind === "principal") readOwner.principalId = "other";
    if (kind === "member") readOwner.userId = "other";
    if (kind === "external actor") readOwner.externalUserId = "other";
    expect(
      await loadDiscordQuestionFormCorrection(
        persistence,
        readScope,
        kind === "handle"
          ? `pcfr:${"X".repeat(43)}`
          : response.paperclipDiscordCorrection.actionId,
        readOwner,
        kind === "thread" ? "other" : threadId,
        now,
      ),
    ).toBeNull();
  });

  it("deletes on expiry access and successful completion without a physical TTL sweep claim", async () => {
    const { persistence, rows, input } = fixture();
    const response = await retainDiscordQuestionFormCorrection(
      persistence,
      scope,
      input,
      now,
    );
    expect(
      await loadDiscordQuestionFormCorrection(
        persistence,
        scope,
        response.paperclipDiscordCorrection.actionId,
        owner,
        threadId,
        new Date(input.parentExpiresAt),
      ),
    ).toBeNull();
    expect(rows.size).toBe(0);
    await retainDiscordQuestionFormCorrection(persistence, scope, input, now);
    await deleteDiscordQuestionFormCorrection(
      persistence,
      scope,
      owner,
      submitActionId,
    );
    expect(rows.size).toBe(0);
  });

  it("caps retention at ten minutes and omits unknown option values", async () => {
    const { persistence, input } = fixture();
    const response = await retainDiscordQuestionFormCorrection(
      persistence,
      scope,
      {
        ...input,
        parentExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        values: { [selectId]: "forged" },
      },
      now,
    );
    const draft = await loadDiscordQuestionFormCorrection(
      persistence,
      scope,
      response.paperclipDiscordCorrection.actionId,
      owner,
      threadId,
      now,
    );
    expect(draft?.expiresAt).toBe(
      new Date(now.getTime() + 600_000).toISOString(),
    );
    expect(draft?.values).toEqual({});
  });

  it("does not issue a reopen handle if draft persistence fails", async () => {
    const { persistence, input } = fixture();
    persistence.compareAndSet = async () => false;
    await expect(
      retainDiscordQuestionFormCorrection(persistence, scope, input, now),
    ).rejects.toThrow("ownership changed");
  });

  it("requires a matching current raw thread identity even without SDK context", () => {
    expect(
      discordQuestionFormThreadId({
        guild_id: "111111111111111111",
        channel_id: "333333333333333333",
        channel: {
          id: "333333333333333333",
          parent_id: "222222222222222222",
          type: 11,
        },
      }),
    ).toBe(threadId);
    expect(
      discordQuestionFormThreadId({
        guild_id: "@me",
        channel_id: "333333333333333333",
        channel: { id: "333333333333333333", type: 1 },
      }),
    ).toBe("discord:@me:333333333333333333");
    expect(
      discordQuestionFormThreadId({
        guild_id: "111111111111111111",
        channel_id: "333333333333333333",
        channel: { id: "other", type: 11 },
      }),
    ).toBeNull();
  });
});

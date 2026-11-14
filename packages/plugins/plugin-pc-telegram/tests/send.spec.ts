import { describe, expect, it } from "vitest";
import { authorizeSendText } from "../src/send.js";
import { AGENT_ID, COMPANY_ID, OTHER_AGENT_ID, OTHER_COMPANY_ID } from "./support.js";
import type { TelegramConnection } from "../src/types.js";

const connection: TelegramConnection = {
  companyId: COMPANY_ID,
  telegramUserId: "1001",
  username: "desk",
  displayName: "Front Desk",
  assignedAgentId: AGENT_ID,
  incomingMode: "dialog_task",
  paused: false,
  sessionSecretId: "secret-1",
  live: true,
};

describe("send authorization", () => {
  it("allows the assigned agent to send to the issue chat", () => {
    const result = authorizeSendText([connection], {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      issueOriginId: "1001:2002",
      text: "On it",
    });
    expect(result).toMatchObject({ ok: true, accountId: "1001", peerId: "2002" });
  });

  it("rejects an unassigned connection", () => {
    const result = authorizeSendText([{ ...connection, assignedAgentId: null }], {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      accountId: "1001",
      peerId: "2002",
      text: "Hi",
    });
    expect(result).toEqual({
      ok: false,
      error: "No answering agent is assigned on this Telegram connection.",
    });
  });

  it("rejects an unauthorized agent and a foreign company", () => {
    expect(authorizeSendText([connection], {
      companyId: COMPANY_ID,
      agentId: OTHER_AGENT_ID,
      accountId: "1001",
      peerId: "2002",
      text: "Hi",
    }).ok).toBe(false);
    expect(authorizeSendText([connection], {
      companyId: OTHER_COMPANY_ID,
      agentId: AGENT_ID,
      accountId: "1001",
      peerId: "2002",
      text: "Hi",
    }).ok).toBe(false);
  });

  it("rejects sending to a different chat than the issue", () => {
    const result = authorizeSendText([connection], {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      accountId: "1001",
      peerId: "9999",
      issueOriginId: "1001:2002",
      text: "Hi",
    });
    expect(result.ok).toBe(false);
  });
});

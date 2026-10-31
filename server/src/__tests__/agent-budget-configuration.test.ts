import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { AgentConfigurationRecord } from "../lib/agent-records.js";
import { prepareAgentConfiguration } from "../services/agent-configuration.js";

const existing = { id: "agent", companyId: "company", status: "idle", budgetMonthlyCents: 500 } as AgentConfigurationRecord;
describe("budget authority in configuration preparation", () => {
  it("rejects agent-originated budget changes before persistence or policy audit", async () => {
    const db = {} as Db;
    await expect(prepareAgentConfiguration(db, existing, { budgetMonthlyCents: 5000 }, { recordRevision: { createdByAgentId: "ceo" } })).rejects.toMatchObject({ status: 403 });
    await expect(prepareAgentConfiguration(db, existing, { budgetMonthlyCents: 0 }, { recordRevision: { createdByAgentId: "ceo" } })).rejects.toMatchObject({ status: 403 });
  });
  it("removes an unchanged legacy budget from agent rollback so it cannot rewrite policy or invent a board actor", async () => {
    expect(await prepareAgentConfiguration({} as Db, existing, { budgetMonthlyCents: 500 }, { recordRevision: { createdByAgentId: "ceo", source: "rollback" } })).toEqual({});
  });
  it("preserves the actual board-authorized amount for the existing policy writer", async () => {
    expect(await prepareAgentConfiguration({} as Db, existing, { budgetMonthlyCents: 5000 }, { recordRevision: { createdByUserId: "operator-user" } })).toEqual({ budgetMonthlyCents: 5000 });
  });
});

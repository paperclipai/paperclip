import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { findConnection, listKnownCompanyIds, patchConnection, upsertConnection } from "../src/connections.js";
import manifest from "../src/manifest.js";
import { AGENT_ID, COMPANY_ID } from "./support.js";

describe("connected companies", () => {
  it("reads company ids from account entities", async () => {
    const harness = createTestHarness({ manifest });
    expect(await listKnownCompanyIds(harness.ctx)).toEqual([]);
    await upsertConnection(harness.ctx, {
      companyId: COMPANY_ID,
      account: { telegramUserId: "1001", username: "desk", displayName: "Front Desk" },
      sessionSecretId: "secret-1",
      sessionConfigPath: "plugin-secret.secret-1",
    });
    expect(await listKnownCompanyIds(harness.ctx)).toEqual([COMPANY_ID]);
  });

  it("keeps a sender policy when login omits it and drops ids that are not users", async () => {
    const harness = createTestHarness({ manifest });
    const saved = await upsertConnection(harness.ctx, {
      companyId: COMPANY_ID,
      account: { telegramUserId: "1001", username: "desk", displayName: "Front Desk" },
      sessionSecretId: "secret-1",
      assignedAgentId: AGENT_ID,
      acceptUnlistedSenders: true,
      allowedPeerIds: ["2002", "2002", "0", "abc"],
    });
    expect(saved.acceptUnlistedSenders).toBe(true);
    expect(saved.allowedPeerIds).toEqual(["2002"]);
    const relogin = await upsertConnection(harness.ctx, {
      companyId: COMPANY_ID,
      account: { telegramUserId: "1001", username: "desk", displayName: "Front Desk" },
      sessionSecretId: "secret-2",
    });
    expect(relogin.assignedAgentId).toBe(AGENT_ID);
    expect(relogin.acceptUnlistedSenders).toBe(true);
    expect(relogin.allowedPeerIds).toEqual(["2002"]);
    const found = await findConnection(harness.ctx, COMPANY_ID, "1001", new Set());
    expect(found?.acceptUnlistedSenders).toBe(true);
    expect(found?.allowedPeerIds).toEqual(["2002"]);
    const patched = await patchConnection(harness.ctx, COMPANY_ID, "1001", {
      allowedPeerIds: [],
    }, new Set());
    expect(patched.assignedAgentId).toBe(AGENT_ID);
    expect(patched.acceptUnlistedSenders).toBe(true);
    expect(patched.allowedPeerIds).toEqual([]);
    const closed = await upsertConnection(harness.ctx, {
      companyId: COMPANY_ID,
      account: { telegramUserId: "3003", username: null, displayName: "Closed" },
      sessionSecretId: "secret-3",
    });
    expect(closed.acceptUnlistedSenders).toBe(false);
    expect(closed.allowedPeerIds).toEqual([]);
    const closedFound = await findConnection(harness.ctx, COMPANY_ID, "3003", new Set());
    expect(closedFound?.acceptUnlistedSenders).toBe(false);
    expect(closedFound?.allowedPeerIds).toEqual([]);
  });
});

import { PGlite } from "@electric-sql/pglite";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { createControl } from "../src/control.js";
import { createStore } from "../src/store.js";
import { company, config, database, host, initialise, issueId, message } from "./helpers.js";

const pg = new PGlite();
beforeAll(() => initialise(pg)); afterAll(() => pg.close());
describe("native SDK capability and attribution contract", () => {
  it("passes the shipped manifest through native human-comment and company-member gates", async () => {
    const harness = createTestHarness({ manifest });
    const { issue } = host(database(pg));
    harness.seed({ issues: [issue as never], accessMembers: [{ id: "membership", companyId: company, principalType: "user", principalId: "human", status: "active", membershipRole: "operator", grants: [], createdAt: new Date(), updatedAt: new Date() }] });
    const store = createStore(database(pg), company);
    await store.bind(message, { slackUserId: message.userId, boardUserId: "human", issueId });
    const transport = { verifyDirectMessage: vi.fn().mockResolvedValue(true), reply: vi.fn() };
    const control = createControl(harness.ctx, company, config, store, transport, () => true);
    await control.enqueue({ ...message, eventId: "EvSdk", threadTs: message.ts, ts: "1780000000.000009", text: "Synthetic follow-up" });
    await control.drain();
    expect((await store.recent())[0]?.phase).toBe("done");
    const comments = await harness.ctx.issues.listComments(issueId, company);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "user", authorUserId: "human", authorAgentId: null });
    harness.seed({ accessMembers: [{ id: "membership", companyId: company, principalType: "user", principalId: "human", status: "active", membershipRole: "viewer", grants: [], createdAt: new Date(), updatedAt: new Date() }] });
    await expect(harness.ctx.issues.createComment(issueId, "forbidden", company, { actorUserId: "human" })).rejects.toThrow("viewer");
  });
});

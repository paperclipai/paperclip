import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createControl, ORIGIN } from "../src/control.js";
import { fingerprint } from "../src/config.js";
import { createStore, eventKey } from "../src/store.js";
import { company, config, database, host, initialise, issueId, message, namespace, otherCompany } from "./helpers.js";

const pg = new PGlite();
beforeAll(() => initialise(pg));
afterAll(() => pg.close());
beforeEach(() => pg.exec(`TRUNCATE ${namespace}.inbox, ${namespace}.threads`));
function fixture() {
  const store = createStore(database(pg), company);
  const { ctx, api, issue } = host(database(pg));
  const transport = { verifyDirectMessage: vi.fn().mockResolvedValue(true), reply: vi.fn().mockResolvedValue(undefined) };
  const current = vi.fn(() => true);
  return { store, api, issue, transport, current, control: createControl(ctx, company, config, store, transport, current) };
}
describe("durable task dispatch", () => {
  it("creates once across concurrent delivery and retries, attributes the human, binds and wakes natively", async () => {
    const f = fixture();
    await Promise.all([f.control.enqueue(message), f.control.enqueue(message)]);
    await Promise.all([f.control.drain(), f.control.drain()]);
    await f.control.enqueue({ ...message, text: "new demo: Changed retry payload" });
    await f.control.drain();
    expect(f.api.issues.create).toHaveBeenCalledTimes(1);
    expect(f.api.issues.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: company, actor: { actorUserId: "human" }, originKind: ORIGIN, originId: eventKey(message), description: "Synthetic task" }));
    expect(f.api.issues.requestWakeup).toHaveBeenCalledWith(issueId, company, expect.objectContaining({ actorUserId: "human", idempotencyKey: eventKey(message) }));
    expect(await f.store.binding(message)).toEqual({ slackUserId: "UTEST", boardUserId: "human", issueId });
    expect((await f.store.recent())[0]?.phase).toBe("done");
  });
  it("does not retry an ambiguous native creation", async () => {
    const f = fixture();
    f.api.issues.create.mockRejectedValue(new Error("RPC response lost after commit"));
    await f.control.enqueue(message); await f.control.drain(); await f.control.enqueue(message); await f.control.drain();
    expect(f.api.issues.create).toHaveBeenCalledTimes(1);
    expect((await f.store.recent())[0]?.phase).toBe("uncertain");
    expect(f.transport.reply).not.toHaveBeenCalled();
  });
  it("recovers a crashed working event by its native origin without creating again", async () => {
    const f = fixture(); await f.control.enqueue(message); await f.store.claim(eventKey(message));
    f.api.issues.list.mockResolvedValue([f.issue]);
    await f.control.drain();
    expect(f.api.issues.create).not.toHaveBeenCalled();
    expect(await f.store.binding(message)).toMatchObject({ issueId });
    expect((await f.store.recent())[0]?.phase).toBe("done");
  });
  it("stops after a crash before creation if the outcome cannot be established", async () => {
    const f = fixture(); await f.control.enqueue(message); await f.store.claim(eventKey(message)); await f.control.drain();
    expect(f.api.issues.create).not.toHaveBeenCalled();
    expect((await f.store.recent())[0]?.phase).toBe("uncertain");
  });
  it("retains a known completed task when the Slack reply fails", async () => {
    const f = fixture(); f.transport.reply.mockRejectedValue(new Error("Slack response lost"));
    await f.control.enqueue(message); await f.control.drain(); await f.control.drain();
    expect((await f.store.recent())[0]).toMatchObject({ phase: "done", issueId });
    expect(f.api.issues.create).toHaveBeenCalledTimes(1);
    expect(f.transport.reply).toHaveBeenCalledTimes(1);
  });
  it("keeps a created task when native wake is blocked, without changing approvals or budgets", async () => {
    const f = fixture(); f.api.issues.requestWakeup.mockRejectedValue(new Error("Budget blocks invocation"));
    await f.control.enqueue(message); await f.control.drain();
    expect((await f.store.recent())[0]).toMatchObject({ phase: "done", issueId });
    expect(f.transport.reply).toHaveBeenCalledWith(message, expect.stringContaining("wake was not confirmed"));
  });
  it("does not dispatch for a read-only viewer", async () => {
    const f = fixture(); f.api.access.members.list.mockResolvedValue([{ companyId: company, principalType: "user", principalId: "human", status: "active", membershipRole: "viewer" }]);
    await f.control.enqueue(message); await f.control.drain(); expect(f.api.issues.create).not.toHaveBeenCalled();
  });
  it.each([[], [{ companyId: otherCompany, principalType: "user", principalId: "human", status: "active" }], [{ companyId: company, principalType: "agent", principalId: "human", status: "active" }], [{ companyId: company, principalType: "user", principalId: "human", status: "inactive" }]].map((members) => ({ members })))("rejects missing, cross-company or non-human membership", async ({ members }) => {
    const f = fixture(); f.api.access.members.list.mockResolvedValue(members);
    await f.control.enqueue(message); await f.control.drain();
    expect(f.api.issues.create).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
    expect((await f.store.recent())[0]?.phase).toBe("uncertain");
  });
  it("revalidates the DM with Slack, failing closed", async () => {
    const f = fixture(); f.transport.verifyDirectMessage.mockResolvedValue(false);
    await f.control.enqueue(message); await f.control.drain();
    expect(f.api.issues.create).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
  });
  it("does not execute queued events after configuration changes", async () => {
    const f = fixture(); await f.store.enqueue(message, fingerprint({ ...config, enabled: false })); await f.control.drain();
    expect(f.api.issues.create).not.toHaveBeenCalled(); expect((await f.store.recent())[0]?.phase).toBe("uncertain");
  });
  it("status and unknown commands never create or wake an agent", async () => {
    const f = fixture(); await f.control.enqueue({ ...message, text: "status" }); await f.control.drain();
    await f.control.enqueue({ ...message, eventId: "Ev002", text: "run shell https://example.org" }); await f.control.drain();
    expect(f.api.issues.create).not.toHaveBeenCalled(); expect(f.api.issues.requestWakeup).not.toHaveBeenCalled();
    expect(f.transport.reply).toHaveBeenCalledTimes(2);
  });
  it("rejects an origin belonging to another company, project or author", async () => {
    const f = fixture(); f.api.issues.list.mockResolvedValue([{ ...f.issue, companyId: otherCompany }]);
    await f.control.enqueue(message); await f.control.drain();
    expect(f.api.issues.create).not.toHaveBeenCalled(); expect(f.api.issues.requestWakeup).not.toHaveBeenCalled();
  });
});
describe("thread follow-ups", () => {
  const reply = { ...message, eventId: "EvReply", ts: "1780000000.000002", threadTs: message.ts, text: "Use synthetic data only" };
  it("keeps replies on the bound task with native human attribution", async () => {
    const f = fixture(); await f.store.bind(message, { slackUserId: message.userId, boardUserId: "human", issueId });
    await f.control.enqueue(reply); await f.control.drain(); await f.control.enqueue(reply); await f.control.drain();
    expect(f.api.issues.createComment).toHaveBeenCalledTimes(1);
    expect(f.api.issues.createComment).toHaveBeenCalledWith(issueId, `Use synthetic data only\n\n[Slack event ${eventKey(reply)}]`, company, { actorUserId: "human" });
    expect(f.api.issues.create).not.toHaveBeenCalled();
  });
  it("recovers a committed comment after restart without adding another", async () => {
    const f = fixture(); await f.store.bind(message, { slackUserId: message.userId, boardUserId: "human", issueId });
    await f.control.enqueue(reply); await f.store.claim(eventKey(reply));
    f.api.issues.listComments.mockResolvedValue([{ authorUserId: "human", body: `text\n[Slack event ${eventKey(reply)}]` }]);
    await f.control.drain(); expect(f.api.issues.createComment).not.toHaveBeenCalled(); expect((await f.store.recent())[0]?.phase).toBe("done");
  });
  it("never retries a comment with an unknown outcome", async () => {
    const f = fixture(); await f.store.bind(message, { slackUserId: message.userId, boardUserId: "human", issueId });
    await f.control.enqueue(reply); await f.store.claim(eventKey(reply)); await f.control.drain();
    expect(f.api.issues.createComment).not.toHaveBeenCalled(); expect((await f.store.recent())[0]?.phase).toBe("uncertain");
  });
  it("cannot use a different Slack channel or unbound thread to target a task", async () => {
    const f = fixture(); await f.store.bind(message, { slackUserId: message.userId, boardUserId: "human", issueId });
    await f.control.enqueue({ ...reply, channelId: "DOTHER" }); await f.control.drain();
    expect(f.api.issues.createComment).not.toHaveBeenCalled(); expect(f.api.issues.create).not.toHaveBeenCalled();
  });
  it("rejects a changed board-user mapping", async () => {
    const f = fixture(); await f.store.bind(message, { slackUserId: message.userId, boardUserId: "previous-human", issueId });
    await f.control.enqueue(reply); await f.control.drain();
    expect(f.api.issues.createComment).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
  });
  it("rejects a task moved outside the configured project", async () => {
    const f = fixture(); await f.store.bind(message, { slackUserId: message.userId, boardUserId: "human", issueId });
    f.api.issues.get.mockResolvedValue({ ...f.issue, projectId: otherCompany });
    await f.control.enqueue(reply); await f.control.drain();
    expect(f.api.issues.createComment).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
  });
});

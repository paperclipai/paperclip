import { describe, expect, it } from "vitest";
import { syncLink, resolveApprovalDecision } from "./sync.js";
import { FakePaperclipApi } from "../paperclip/api.js";
import { MemoryStore } from "../store/memory-store.js";
import { MockHermesConnector } from "../hermes/mock.js";
import type { LinkConfig } from "../types.js";

const LINK: LinkConfig = {
  linkId: "L",
  companyA: { companyId: "A", channelIssueId: "iss-A", label: "Rossignol" },
  companyB: { companyId: "B", channelIssueId: "iss-B", label: "PCC" },
  transport: { telegramChat: "chat:1", emailA: "a@x.com", emailB: "b@x.com" },
};

function deps() { return { api: new FakePaperclipApi(), store: new MemoryStore(), hermes: new MockHermesConnector(), link: LINK }; }

describe("syncLink — routine mirror", () => {
  it("mirrors a new routine comment from A to B's channel-issue + Telegram notify", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "brief transmis pour revue");
    await syncLink(d);
    const mirrored = await d.api.listComments("iss-B");
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].metadata?.bridgeOrigin).toBe("A");
    expect(d.hermes.sent.filter((m) => m.channel === "telegram")).toHaveLength(1);
  });
  it("is idempotent: second run mirrors nothing new", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "hello");
    await syncLink(d); await syncLink(d);
    expect(await d.api.listComments("iss-B")).toHaveLength(1);
  });
  it("loop-safe: a bridge-authored comment is never mirrored back", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-B", "echo", { bridgeOrigin: "A" }); // came FROM the bridge
    await syncLink(d);
    expect(await d.api.listComments("iss-A")).toHaveLength(0);
  });
});

describe("syncLink — commitment gate", () => {
  it("commitment item creates an approval, holds (no mirror), Telegram approve/reject", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "[COMMITMENT] lancer kickoff budget 20k€");
    await syncLink(d);
    expect(await d.api.listComments("iss-B")).toHaveLength(0);                 // not mirrored
    expect(d.api.approvals.size).toBe(1);                                       // approval created
    const tg = d.hermes.sent.find((m) => m.channel === "telegram");
    expect(tg?.approvalId).toBeDefined();                                       // approve/reject surface
  });

  it("approve -> mirror + email formal record + confirmation", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "[COMMITMENT] signature mission");
    await syncLink(d);
    const approvalId = [...d.api.approvals.keys()][0];
    await resolveApprovalDecision(d, approvalId, "approve");
    expect(await d.api.listComments("iss-B")).toHaveLength(1);                  // mirrored after approval
    expect(d.hermes.sent.some((m) => m.channel === "email")).toBe(true);        // formal record
    expect((await d.api.getApproval(approvalId))?.status).toBe("approved");
  });

  it("reject -> rejection comment on sender, no mirror", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "[COMMITMENT] signature mission");
    await syncLink(d);
    const approvalId = [...d.api.approvals.keys()][0];
    await resolveApprovalDecision(d, approvalId, "reject");
    expect(await d.api.listComments("iss-B")).toHaveLength(0);
    const senderComments = await d.api.listComments("iss-A");
    expect(senderComments.some((c) => /rejet|refus/i.test(c.body))).toBe(true);
  });
});

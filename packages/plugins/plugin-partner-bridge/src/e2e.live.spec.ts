import { describe, expect, it } from "vitest";
import { syncLink, resolveApprovalDecision } from "./domain/sync.js";
import { FakePaperclipApi } from "./paperclip/api.js";
import { MemoryStore } from "./store/memory-store.js";
import { MockHermesConnector } from "./hermes/mock.js";
import type { LinkConfig } from "./types.js";

const LINK: LinkConfig = {
  linkId: "rossignol-pcc",
  companyA: { companyId: "CON", channelIssueId: "con-ch", label: "Rossignol Voyage" },
  companyB: { companyId: "PRO", channelIssueId: "pro-ch", label: "Product Compass Consulting" },
  transport: { telegramChat: "chat:you", emailA: "ops@ross", emailB: "pcc@x" },
};

describe("E2E vertical slice (§4.3)", () => {
  it("routine out -> reply in -> gated commitment -> approve -> email", async () => {
    const d = { api: new FakePaperclipApi(), store: new MemoryStore(), hermes: new MockHermesConnector(), link: LINK };
    await d.store.ensure();

    // 1. routine out (Rossignol -> PCC)
    await d.api.postComment("con-ch", "Brief de mission transmis pour revue.");
    await syncLink(d);
    expect(await d.api.listComments("pro-ch")).toHaveLength(1);
    expect(d.hermes.sent.some((m) => m.channel === "telegram")).toBe(true);

    // 2. routine in (PCC -> Rossignol)
    await d.api.postComment("pro-ch", "Revue & cadrage livrés — réponse prête.");
    await syncLink(d);
    expect((await d.api.listComments("con-ch")).some((c) => /cadrage/i.test(c.body))).toBe(true);

    // 3. commitment (Rossignol -> PCC) held, then approved -> email.
    // Count only items the bridge mirrored FROM Rossignol onto PCC's channel
    // (pro-ch also carries PCC's own reply from step 2, which is not a mirror).
    const mirroredFromCon = async () =>
      (await d.api.listComments("pro-ch")).filter((c) => c.metadata?.bridgeOrigin === "CON").length;
    await d.api.postComment("con-ch", "[COMMITMENT] Lancer kickoff — budget 18–30 k€, signature.");
    await syncLink(d);
    const approvalId = [...d.api.approvals.keys()][0];
    expect(await mirroredFromCon()).toBe(1); // commitment held — still only the routine mirror
    await resolveApprovalDecision(d, approvalId, "approve");
    expect(await mirroredFromCon()).toBe(2); // commitment mirrored after approval
    expect(d.hermes.sent.some((m) => m.channel === "email")).toBe(true);
  });
});

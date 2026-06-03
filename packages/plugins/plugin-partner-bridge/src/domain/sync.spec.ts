import { describe, expect, it } from "vitest";
import { syncLink } from "./sync.js";
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

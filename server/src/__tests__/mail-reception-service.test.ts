import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, mailAddresses, mailDomains, mailMessages } from "@paperclipai/db";
import { mailAddressService } from "../services/mail-addresses.ts";
import { mailMessageService } from "../services/mail-messages.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mail reception (embedded mail, phase 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let addresses!: ReturnType<typeof mailAddressService>;
  let messages!: ReturnType<typeof mailMessageService>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-rx-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    addresses = mailAddressService(db);
    messages = mailMessageService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(mailMessages);
    await db.delete(mailAddresses);
    await db.delete(mailDomains);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atelier",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", role: "ceo" });
    const domainId = randomUUID();
    await db.insert(mailDomains).values({
      id: domainId,
      companyId,
      domain: "example.com",
      cfZoneId: "zone1",
      status: "active",
      dkimSelector: "atl1",
    });
    return { companyId, agentId, domainId };
  }

  it("creates an agent address and resolves recipients (exact + catch-all)", async () => {
    const { companyId, agentId, domainId } = await seed();

    const mailbox = await addresses.create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);
    expect(mailbox.address).toBe("ceo@example.com");
    expect(mailbox.kind).toBe("mailbox");

    // An agent can hold several addresses.
    await addresses.create(companyId, agentId, { domainId, localPart: "sales" }, boardActor);
    expect(await addresses.list(companyId, { agentId })).toHaveLength(2);

    // Exact match.
    const exact = await addresses.resolveRecipient("ceo@example.com");
    expect(exact?.id).toBe(mailbox.id);

    // No catch-all yet -> unknown recipient rejected.
    expect(await addresses.resolveRecipient("nope@example.com")).toBeNull();

    // Add a catch-all -> unknown recipients now resolve to it.
    const catchAll = await addresses.create(companyId, agentId, { domainId, localPart: "*" }, boardActor);
    expect(catchAll.kind).toBe("catch_all");
    const resolved = await addresses.resolveRecipient("anything@example.com");
    expect(resolved?.id).toBe(catchAll.id);
  });

  it("auto-provisions <handle>@domain mailboxes (per domain and per agent), idempotently", async () => {
    const { companyId, agentId, domainId } = await seed();

    // Provision all agents on the domain -> the CEO gets ceo@example.com.
    await addresses.provisionForDomain(companyId, domainId);
    let mine = await addresses.list(companyId, { agentId });
    expect(mine.map((a) => a.address)).toContain("ceo@example.com");
    expect(mine.find((a) => a.address === "ceo@example.com")?.kind).toBe("mailbox");

    // Idempotent: provisioning again doesn't duplicate.
    await addresses.provisionForDomain(companyId, domainId);
    mine = await addresses.list(companyId, { agentId });
    expect(mine.filter((a) => a.address === "ceo@example.com")).toHaveLength(1);

    // Provision-for-agent covers every attached domain (same result here).
    await addresses.provisionForAgent(companyId, agentId);
    expect((await addresses.list(companyId, { agentId })).filter((a) => a.address === "ceo@example.com")).toHaveLength(1);
  });

  it("outbound queue: enqueue -> claim (sending) -> markSent; failure backs off out of the queue", async () => {
    const { companyId, agentId, domainId } = await seed();
    const addr = await addresses.create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);

    const queued = await messages.enqueueOutbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: addr.address,
      toAddrs: ["someone@dest.example"],
      subject: "Re: hello",
      textBody: "On it.",
      inReplyTo: "<orig@founder.com>",
    });
    expect(queued.direction).toBe("outbound");
    expect(queued.status).toBe("queued");

    // Claiming marks it sending and is single-shot.
    const claimed = await messages.claimDueOutbound(new Date(), 10);
    expect(claimed.map((c) => c.id)).toContain(queued.id);
    expect(claimed.find((c) => c.id === queued.id)?.status).toBe("sending");
    expect(await messages.claimDueOutbound(new Date(), 10)).toHaveLength(0);

    await messages.markSent(queued.id);

    // A second message that fails goes to "failed" with a future retry time, so it
    // is not immediately re-claimed.
    const q2 = await messages.enqueueOutbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: addr.address,
      toAddrs: ["nope@dest.example"],
      textBody: "x",
    });
    const [c2] = await messages.claimDueOutbound(new Date(), 10);
    expect(c2.id).toBe(q2.id);
    await messages.markFailed(c2.id, "no MX");
    expect(await messages.claimDueOutbound(new Date(), 10)).toHaveLength(0);
  });

  it("records inbound mail, lists the inbox, and marks read", async () => {
    const { companyId, agentId, domainId } = await seed();
    const mailbox = await addresses.create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);

    await messages.recordInbound(companyId, {
      addressId: mailbox.id,
      agentId,
      fromAddr: "human@founder.com",
      toAddrs: ["ceo@example.com"],
      subject: "Hello agent",
      textBody: "Please reply when you can.",
    });

    const inbox = await messages.listInbox(companyId, agentId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].subject).toBe("Hello agent");
    expect(inbox[0].status).toBe("received");

    // Run-context summary is non-empty while unread.
    expect(await messages.buildRunEmailSummary(companyId, agentId)).toContain("unread email");

    const read = await messages.markRead(companyId, inbox[0].id);
    expect(read.status).toBe("read");
    // Once read, it drops out of the unread summary.
    expect(await messages.buildRunEmailSummary(companyId, agentId)).toBe("");
  });
});

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  cloudflareConnections,
  companies,
  companySecrets,
  companySecretBindings,
  companySecretVersions,
  createDb,
  mailDomains,
} from "@paperclipai/db";
import { cloudflareService } from "../services/cloudflare.ts";
import { mailDomainService } from "../services/mail-domains.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };

/** A Cloudflare v4 API mock: returns the right envelope per path/method. */
function cloudflareFetchMock() {
  return vi.fn(async (input: URL | string, init?: { method?: string }) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const p = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const ok = (result: unknown) =>
      ({ ok: true, status: 200, json: async () => ({ success: true, result }) }) as unknown as Response;

    if (p === "/user/tokens/verify") return ok({ id: "tok1", status: "active" });
    if (p === "/accounts") return ok([{ id: "acct1", name: "Acme" }]);
    if (p === "/zones") {
      const name = url.searchParams.get("name");
      const zones = [{ id: "zone1", name: "example.com", status: "active" }];
      return ok(name ? zones.filter((z) => z.name === name) : zones);
    }
    if (/^\/zones\/[^/]+\/dns_records$/.test(p)) {
      if (method === "POST") return ok({ id: randomUUID() });
      // GET: return one existing record (content includes v=spf1 so the SPF
      // content filter on delete matches it too).
      return ok([{ id: "rec1", content: "v=spf1 ip4:203.0.113.1 ~all" }]);
    }
    if (/^\/zones\/[^/]+\/dns_records\/[^/]+$/.test(p)) return ok({ id: "rec1" });
    return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ message: "not found" }] }) } as unknown as Response;
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cloudflare + mail domains (embedded mail, phase 0)", () => {
  let db!: ReturnType<typeof createDb>;
  let cf!: ReturnType<typeof cloudflareService>;
  let mail!: ReturnType<typeof mailDomainService>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousMailHost = process.env.MAIL_HOSTNAME;
  const secretsTmpDir = path.join(os.tmpdir(), `atelier-mail-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    process.env.MAIL_HOSTNAME = "mail.atelier.test";
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    cf = cloudflareService(db);
    mail = mailDomainService(db);
  }, 20_000);

  beforeEach(() => {
    vi.stubGlobal("fetch", cloudflareFetchMock());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(mailDomains);
    await db.delete(cloudflareConnections);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousMailHost === undefined) delete process.env.MAIL_HOSTNAME;
    else process.env.MAIL_HOSTNAME = previousMailHost;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atelier",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("connects Cloudflare, storing the token as a secret (never on the connection row)", async () => {
    const companyId = await seedCompany();
    const conn = await cf.connect(companyId, { apiToken: "cf-token-XYZ" }, boardActor);

    expect(conn.status).toBe("active");
    expect(conn.cfAccountId).toBe("acct1");

    // The raw token is stored as a company secret, not as a column on the row.
    const tokenSecret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId))
      .then((rows) => rows.find((r) => r.name === "CLOUDFLARE_API_TOKEN"));
    expect(tokenSecret).toBeTruthy();
    const [row] = await db
      .select()
      .from(cloudflareConnections)
      .where(eq(cloudflareConnections.companyId, companyId));
    expect(row.apiTokenSecretId).toBe(tokenSecret!.id);
    expect(JSON.stringify(conn)).not.toContain("cf-token-XYZ");
  });

  it("lists attachable zones from the connected account", async () => {
    const companyId = await seedCompany();
    await cf.connect(companyId, { apiToken: "cf-token-XYZ" }, boardActor);
    const zones = await cf.listZones(companyId);
    expect(zones).toEqual([{ id: "zone1", name: "example.com", status: "active" }]);
  });

  it("attaches a domain: generates DKIM, publishes DNS, stores the private key as a secret", async () => {
    const companyId = await seedCompany();
    await cf.connect(companyId, { apiToken: "cf-token-XYZ" }, boardActor);

    const domain = await mail.attach(companyId, "example.com", boardActor);

    expect(domain.domain).toBe("example.com");
    expect(domain.cfZoneId).toBe("zone1");
    expect(domain.dkimSelector).toBe("atl1");
    expect(domain.dkimPublicKey).toBeTruthy();
    // MAIL_HOSTNAME is set, so MX + SPF + DKIM + DMARC all publish -> active.
    expect(domain.mxConfigured).toBe(true);
    expect(domain.spfConfigured).toBe(true);
    expect(domain.dmarcConfigured).toBe(true);
    expect(domain.status).toBe("active");

    // DKIM private key is stored as a company secret, and never exposed in the projection.
    const dkimSecret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId))
      .then((rows) => rows.find((r) => r.name === "mail-dkim:example.com"));
    expect(dkimSecret).toBeTruthy();
    const [dbRow] = await db.select().from(mailDomains).where(eq(mailDomains.companyId, companyId));
    expect(dbRow.dkimPrivateKeySecretId).toBe(dkimSecret!.id);
    expect(JSON.stringify(domain)).not.toContain("PRIVATE KEY");

    // Re-attaching is idempotent (unique on company+domain) and reuses the DKIM key.
    const again = await mail.attach(companyId, "example.com", boardActor);
    expect(again.id).toBe(domain.id);
    expect(again.dkimPublicKey).toBe(domain.dkimPublicKey);
    const all = await mail.list(companyId);
    expect(all).toHaveLength(1);
  });

  it("detach removes the domain and cleans up the published DNS records", async () => {
    const companyId = await seedCompany();
    await cf.connect(companyId, { apiToken: "cf-token-XYZ" }, boardActor);
    const domain = await mail.attach(companyId, "example.com", boardActor);

    const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown, { method?: string }?]> } };
    await mail.remove(companyId, domain.id);

    // DELETE calls were issued against dns_records to clean up the zone.
    const deleteCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).includes("/dns_records/") && init?.method === "DELETE",
    );
    expect(deleteCalls.length).toBeGreaterThan(0);

    // The domain row is gone.
    expect(await mail.list(companyId)).toHaveLength(0);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companyMemberships, issueAccessGrants, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { issueService } from "../services/issues.js";
import { taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("imported attachment authenticated native reads", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  let member: { id: string; cookie: string }, foreign: { id: string; cookie: string };
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
    // Reuse real sessions rather than exhausting the sign-in rate limit during setup.
    member = await user();
    foreign = await user();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
  });

  async function fixture() {
    const f = await server.fixture({ connectionScenario: "fresh" });
    await server.db.insert(companyMemberships).values([
      { companyId: f.companyId, principalType: "user", principalId: member.id, status: "active", membershipRole: "member" },
      { companyId: f.foreignCompanyId, principalType: "user", principalId: foreign.id, status: "active", membershipRole: "member" },
    ]);
    const body = Buffer.from("Synthetic quarantined attachment bytes");
    const stored = await server.storage.putFile({ companyId: f.companyId, namespace: `issues/${f.issueId}`,
      originalFilename: "synthetic.txt", contentType: "text/plain", body });
    await issueService(server.db).addImportedAttachments([{ companyId: f.companyId, issueId: f.issueId,
      issueCommentId: null, ...stored, createdByAgentId: null, createdByUserId: null }]);
    const [attachment] = await issueService(server.db).listAttachments(f.issueId);
    return { ...f, body, attachment, cookie: member.cookie };
  }

  async function user() {
    const id = randomUUID();
    await server.db.insert(authUsers).values({ id, name: "Synthetic reader", email: `${id}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    return { id, cookie: await server.humanSession(id) };
  }

  function read(attachmentId: string, cookie?: string, range?: string) {
    return fetch(`${server.apiUrl}/api/attachments/${attachmentId}/content`, {
      headers: { ...(cookie ? { cookie } : {}), ...(range ? { range } : {}) },
    });
  }

  it("allows an authenticated company member to inspect bytes without granting provider output", async () => {
    const f = await fixture();
    const response = await read(f.attachment.id, f.cookie);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.body);
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: f.issueId })).toBe(true);
  });

  it.each(["anonymous", "foreign_company"] as const)("denies %s before storage access", async variant => {
    const f = await fixture();
    const cookie = variant === "foreign_company" ? foreign.cookie : undefined;
    const storageRead = vi.spyOn(server.storage, "getObject");
    try {
      const response = await read(f.attachment.id, cookie);
      expect([401, 403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(f.body.toString());
      expect(storageRead).not.toHaveBeenCalled();
    } finally { storageRead.mockRestore(); }
  });

  it.each(["task", "ancestor"] as const)("requires a current private %s read grant even for a valid byte range", async variant => {
    const f = await fixture(), reader = member;
    let privateIssueId = f.issueId;
    if (variant === "ancestor") {
      const [parent] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Synthetic private ancestor", visibility: "private" }).returning();
      privateIssueId = parent.id;
      await server.db.update(issues).set({ privacyParentIssueId: parent.id }).where(eq(issues.id, f.issueId));
    } else await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issueId));
    const storageRead = vi.spyOn(server.storage, "getObject");
    try {
      const denied = await read(f.attachment.id, reader.cookie, "bytes=0-8");
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain(f.body.toString());
      expect(storageRead).not.toHaveBeenCalled();
      const [grant] = await server.db.insert(issueAccessGrants).values({ issueId: privateIssueId, subjectType: "user", subjectId: reader.id, source: "explicit" }).returning();
      const allowed = await read(f.attachment.id, reader.cookie, "bytes=0-8");
      expect(allowed.status).toBe(206);
      expect(Buffer.from(await allowed.arrayBuffer())).toEqual(f.body.subarray(0, 9));
      expect(storageRead).toHaveBeenCalledTimes(1);
      await server.db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
      const revoked = await read(f.attachment.id, reader.cookie);
      expect(revoked.status).toBe(404);
      await revoked.arrayBuffer();
      expect(storageRead).toHaveBeenCalledTimes(1);
      expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: f.issueId })).toBe(true);
    } finally { storageRead.mockRestore(); }
  });
});

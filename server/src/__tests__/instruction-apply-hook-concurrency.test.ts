import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, approvals, companies, createDb, issueApprovals, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { INSTRUCTION_APPLY_ORIGIN_KIND, createInstructionApplyTask } from "../services/instruction-apply-hook.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("instruction apply task under concurrent approvals", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-instruction-apply-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Apply", issuePrefix: "APL", defaultResponsibleUserId: "board-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", adapterType: "process" });
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("returns one committed task to overlapping approvals of the same bundle", async () => {
    const payload = { agentId, bundle: { files: [{ path: "AGENTS.md", content: "# Approved\n", baseHash: null }] } };
    const results = await Promise.all(
      [randomUUID(), randomUUID(), randomUUID()].map((approvalId) =>
        createInstructionApplyTask(db, { companyId, approvalId, decidedByUserId: "board-user", payload }),
      ),
    );

    expect(results.every((result) => result !== null)).toBe(true);
    expect(new Set(results.map((result) => result!.issueId)).size).toBe(1);
    expect(results.filter((result) => result!.created)).toHaveLength(1);
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, INSTRUCTION_APPLY_ORIGIN_KIND)));
    expect(rows).toEqual([{ id: results[0]!.issueId }]);
  });

  it("creates the apply task inside the privacy root of a private linked task", async () => {
    const privateIssueId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(issues).values({
      id: privateIssueId, companyId, title: "Private source", visibility: "private", privacyRootIssueId: privateIssueId,
    });
    const payload = { agentId, bundle: { files: [{ path: "AGENTS.md", content: "# Private approved\n", baseHash: null }] } };
    await db.insert(approvals).values({ id: approvalId, companyId, type: "instruction_generation", payload });
    await db.insert(issueApprovals).values({ companyId, issueId: privateIssueId, approvalId });

    const result = await createInstructionApplyTask(db, { companyId, approvalId, decidedByUserId: "board-user", payload });

    expect(result?.created).toBe(true);
    const [task] = await db
      .select({ parentId: issues.parentId, visibility: issues.visibility, privacyRootIssueId: issues.privacyRootIssueId })
      .from(issues)
      .where(eq(issues.id, result!.issueId));
    expect(task).toEqual({ parentId: privateIssueId, visibility: "private", privacyRootIssueId: privateIssueId });
  });

  it("does not reuse an open apply task for a private approval of the same bundle", async () => {
    const payload = { agentId, bundle: { files: [{ path: "AGENTS.md", content: "# Shared bundle\n", baseHash: null }] } };
    const openApprovalId = randomUUID();
    await db.insert(approvals).values({ id: openApprovalId, companyId, type: "instruction_generation", payload });
    const openResult = await createInstructionApplyTask(db, { companyId, approvalId: openApprovalId, decidedByUserId: "board-user", payload });

    const privateIssueId = randomUUID();
    const privateApprovalId = randomUUID();
    await db.insert(issues).values({
      id: privateIssueId, companyId, title: "Private twin", visibility: "private", privacyRootIssueId: privateIssueId,
    });
    await db.insert(approvals).values({ id: privateApprovalId, companyId, type: "instruction_generation", payload });
    await db.insert(issueApprovals).values({ companyId, issueId: privateIssueId, approvalId: privateApprovalId });
    const privateResult = await createInstructionApplyTask(db, { companyId, approvalId: privateApprovalId, decidedByUserId: "board-user", payload });

    expect(openResult?.created).toBe(true);
    expect(privateResult?.created).toBe(true);
    expect(privateResult!.issueId).not.toBe(openResult!.issueId);
    const [task] = await db
      .select({ parentId: issues.parentId, visibility: issues.visibility })
      .from(issues)
      .where(eq(issues.id, privateResult!.issueId));
    expect(task).toEqual({ parentId: privateIssueId, visibility: "private" });
  });

  it("reuses one apply task for repeated approvals linked to a nested private task", async () => {
    const rootIssueId = randomUUID();
    const nestedIssueId = randomUUID();
    await db.insert(issues).values({
      id: rootIssueId, companyId, title: "Private root", visibility: "private", privacyRootIssueId: rootIssueId,
    });
    await db.insert(issues).values({
      id: nestedIssueId, companyId, title: "Private nested source", parentId: rootIssueId,
      visibility: "private", privacyRootIssueId: rootIssueId, privacyParentIssueId: rootIssueId,
    });
    const payload = { agentId, bundle: { files: [{ path: "AGENTS.md", content: "# Nested approved\n", baseHash: null }] } };
    const approvalIds = [randomUUID(), randomUUID()];
    for (const approvalId of approvalIds) {
      await db.insert(approvals).values({ id: approvalId, companyId, type: "instruction_generation", payload });
      await db.insert(issueApprovals).values({ companyId, issueId: nestedIssueId, approvalId });
    }

    const first = await createInstructionApplyTask(db, { companyId, approvalId: approvalIds[0]!, decidedByUserId: "board-user", payload });
    const second = await createInstructionApplyTask(db, { companyId, approvalId: approvalIds[1]!, decidedByUserId: "board-user", payload });

    expect(first?.created).toBe(true);
    expect(second).toEqual({ issueId: first!.issueId, created: false });
    const [task] = await db
      .select({
        parentId: issues.parentId,
        privacyParentIssueId: issues.privacyParentIssueId,
        visibility: issues.visibility,
        privacyRootIssueId: issues.privacyRootIssueId,
      })
      .from(issues)
      .where(eq(issues.id, first!.issueId));
    // Depth flattening does not nest the task under the source; privacy still follows the source.
    expect(task).toEqual({
      parentId: null, privacyParentIssueId: nestedIssueId, visibility: "private", privacyRootIssueId: rootIssueId,
    });
  });
});

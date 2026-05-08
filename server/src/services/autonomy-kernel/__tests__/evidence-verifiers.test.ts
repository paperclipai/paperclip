import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createDefaultEvidenceValidatorAdapters } from "../evidence-verifiers.js";
import { createEvidenceValidatorRegistry } from "../validators.js";

const execFile = promisify(execFileCallback);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function candidate(overrides: Record<string, unknown>) {
  return {
    type: "work_product" as const,
    title: "candidate",
    summary: null,
    uri: null,
    payload: {},
    sourceType: "heartbeat_run" as const,
    sourceId: "run-1",
    ...overrides,
  };
}

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "paperclip-evidence-verifier-"));
}

describe("default autonomy evidence verifier adapters", () => {
  it("verifies commit evidence against a real local git workspace", async () => {
    const repoDir = await createTempDir();
    try {
      await execFile("git", ["init"], { cwd: repoDir });
      await execFile("git", ["config", "user.email", "paperclip@example.invalid"], { cwd: repoDir });
      await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: repoDir });
      await fs.writeFile(path.join(repoDir, "README.md"), "evidence\n");
      await execFile("git", ["add", "README.md"], { cwd: repoDir });
      await execFile("git", ["commit", "-m", "evidence"], { cwd: repoDir });
      const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir });
      const sha = stdout.trim();

      const registry = createEvidenceValidatorRegistry({ adapters: createDefaultEvidenceValidatorAdapters({} as never) });

      await expect(
        registry.validateEvidenceCandidate(candidate({ type: "commit", uri: `commit:${sha}`, payload: { commitSha: sha, repoPath: repoDir } })),
      ).resolves.toMatchObject({
        verdict: "accepted",
        reason: "Accepted commit evidence: repository verifier confirmed the commit exists.",
      });
      await expect(
        registry.validateEvidenceCandidate(candidate({ type: "commit", payload: { commitSha: sha } })),
      ).resolves.toMatchObject({ verdict: "rejected", reason: "Rejected commit evidence: no repository workspace path was supplied." });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it("verifies file artifacts inside the supplied workspace and rejects traversal", async () => {
    const workspace = await createTempDir();
    try {
      await fs.mkdir(path.join(workspace, "artifacts"));
      await fs.writeFile(path.join(workspace, "artifacts", "result.json"), "{}\n");
      const registry = createEvidenceValidatorRegistry({ adapters: createDefaultEvidenceValidatorAdapters({} as never) });

      await expect(
        registry.validateEvidenceCandidate(candidate({ type: "work_product", uri: "artifacts/result.json", payload: { workspacePath: workspace } })),
      ).resolves.toMatchObject({
        verdict: "accepted",
        reason: "Accepted work_product evidence: verifier confirmed the artifact exists.",
      });
      await expect(
        registry.validateEvidenceCandidate(candidate({ type: "document", uri: "../outside.md", payload: { workspacePath: workspace } })),
      ).resolves.toMatchObject({
        verdict: "rejected",
        reason: "Evidence path resolves outside the supplied workspace base path.",
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects localhost URLs without making them accepted evidence", async () => {
    const registry = createEvidenceValidatorRegistry({ adapters: createDefaultEvidenceValidatorAdapters({} as never) });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "external_api_check", uri: "http://127.0.0.1:3100/api/health", payload: { url: "http://127.0.0.1:3100/api/health" } })),
    ).resolves.toMatchObject({
      verdict: "rejected",
      reason: "Rejected URL evidence: private or localhost URLs are not accepted by the default verifier.",
    });
  });
});

describeEmbeddedPostgres("default approval evidence verifier adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evidence-verifiers-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("verifies approval evidence against finalized company-scoped approval rows", async () => {
    const companyId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "autonomy_test",
      status: "approved",
      payload: {},
      decidedByUserId: "human-operator",
      decidedAt: new Date(),
    });

    const registry = createEvidenceValidatorRegistry({ adapters: createDefaultEvidenceValidatorAdapters(db) });

    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "approval_decision", payload: { companyId, decisionId: approvalId, decision: "approved" } })),
    ).resolves.toMatchObject({
      verdict: "accepted",
      reason: "Accepted approval_decision evidence: audited approval decision metadata is present.",
    });
    await expect(
      registry.validateEvidenceCandidate(candidate({ type: "approval_decision", payload: { companyId, decisionId: approvalId, decision: "rejected" } })),
    ).resolves.toMatchObject({
      verdict: "rejected",
      reason: "Rejected approval evidence: recorded approval status does not match candidate decision.",
    });
  });
});

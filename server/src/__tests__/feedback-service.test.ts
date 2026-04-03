import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  agents,
  applyPendingMigrations,
  companies,
  companySkills,
  costEvents,
  createDb,
  documents,
  documentRevisions,
  ensurePostgresDatabase,
  feedbackExports,
  feedbackVotes,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { feedbackService } from "../services/feedback.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-feedback-service-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("feedbackService.saveIssueVote", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof feedbackService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let tempDirs: string[] = [];

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = feedbackService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(feedbackExports);
    await db.delete(feedbackVotes);
    await db.delete(instanceSettings);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(companySkills);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    tempDirs = [];
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedIssueWithAgentComment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Add feedback voting",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "AI generated update",
    });

    return { companyId, issueId, commentId };
  }

  async function seedIssueWithRichAgentComment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const targetCommentId = randomUUID();
    const earlierCommentId = randomUUID();
    const laterCommentId = randomUUID();
    // Use a deterministic UUID whose hyphen-separated segments cannot be
    // mistaken for a phone number by the PII redactor's phone regex.
    // Random UUIDs occasionally produce digit pairs like "4880-8614" that
    // cross segment boundaries and match the phone pattern.
    const runId = "abcde123-face-beef-cafe-abcdef654321";
    const instructionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-feedback-instructions-"));
    tempDirs.push(instructionsDir);
    const instructionsPath = path.join(instructionsDir, "AGENTS.md");
    fs.writeFileSync(
      instructionsPath,
      "You are a coder.\nUse api_key=secret-value.\nPrefer /Users/dotta/private-workspace.",
      "utf8",
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companySkills).values([
      {
        id: randomUUID(),
        companyId,
        key: "paperclipai/paperclip/paperclip",
        slug: "paperclip",
        name: "Paperclip",
        markdown: "# Paperclip",
        sourceType: "catalog",
        sourceLocator: null,
        sourceRef: null,
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      },
      {
        id: randomUUID(),
        companyId,
        key: "octo/research/public-skill",
        slug: "public-skill",
        name: "Public Skill",
        markdown: "# Public Skill",
        sourceType: "github",
        sourceLocator: "https://github.com/octo/research/tree/main/skills/public-skill",
        sourceRef: "main",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: writePaperclipSkillSyncPreference(
        {
          model: "gpt-5.4",
          instructionsBundleMode: "external",
          instructionsRootPath: instructionsDir,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: instructionsPath,
        },
        ["paperclipai/paperclip/paperclip", "octo/research/public-skill"],
      ),
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 3600,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Trace-rich feedback",
      description: "Issue context includes ops@example.com and a backup phone 555 111 2222.",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "succeeded",
      startedAt: new Date("2026-03-30T10:00:00.000Z"),
      finishedAt: new Date("2026-03-30T10:05:00.000Z"),
      usageJson: {
        provider: "openai",
        model: "gpt-5.4",
        inputTokens: 123,
        outputTokens: 45,
        costUsd: 0.12,
      },
    });

    await db.insert(costEvents).values({
      id: randomUUID(),
      companyId,
      agentId,
      issueId,
      heartbeatRunId: runId,
      provider: "openai",
      biller: "openai",
      billingType: "metered",
      model: "gpt-5.4",
      inputTokens: 123,
      cachedInputTokens: 0,
      outputTokens: 45,
      costCents: 12,
      occurredAt: new Date("2026-03-30T10:05:00.000Z"),
    });

    await db.insert(issueComments).values([
      {
        id: earlierCommentId,
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: runId,
        body: "Previous comment with ops@example.com in it.",
        createdAt: new Date("2026-03-30T10:01:00.000Z"),
      },
      {
        id: targetCommentId,
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: runId,
        body: "Target output with api_key=secret-value and Bearer secret-token.",
        createdAt: new Date("2026-03-30T10:02:00.000Z"),
      },
      {
        id: laterCommentId,
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: runId,
        body: "Later comment mentions 555 111 2222 for follow-up.",
        createdAt: new Date("2026-03-30T10:03:00.000Z"),
      },
    ]);

    return { companyId, issueId, targetCommentId, runId };
  }

  async function seedIssueWithAgentDocument() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Document feedback",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Drafted by an agent",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      body: "Drafted by an agent",
      createdByAgentId: agentId,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });

    return { companyId, issueId, revisionId };
  }

  async function seedIssueWithAdapterRunComment(input: {
    adapterType: "claude_local" | "opencode_local";
    sessionId: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TraceCollector",
      role: "engineer",
      status: "active",
      adapterType: input.adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Trace-backed feedback",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "succeeded",
      sessionIdAfter: input.sessionId,
      startedAt: new Date("2026-04-01T10:00:00.000Z"),
      finishedAt: new Date("2026-04-01T10:05:00.000Z"),
      usageJson: {
        provider: input.adapterType === "claude_local" ? "anthropic" : "opencode",
        model: input.adapterType === "claude_local" ? "claude-opus-4-6" : "opencode/minimax-m2.5-free",
      },
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Trace-backed agent output",
    });

    return { companyId, issueId, commentId };
  }

  it("stores a local vote without enabling sharing by default", async () => {
    const { companyId, issueId, commentId } = await seedIssueWithAgentComment();

    const result = await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "up",
      authorUserId: "user-1",
    });

    expect(result.vote.vote).toBe("up");
    expect(result.sharingEnabled).toBe(false);
    expect(result.persistedSharingPreference).toBe("not_allowed");
    expect(result.vote.consentVersion).toBeNull();

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    expect(company?.feedbackDataSharingEnabled).toBe(false);
    expect(company?.feedbackDataSharingConsentAt).toBeNull();

    const settings = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .then((rows) => rows[0] ?? null);

    expect(settings?.general).toMatchObject({
      feedbackDataSharingPreference: "not_allowed",
    });

    const traces = await svc.listFeedbackTraces({
      companyId,
      issueId,
      includePayload: true,
    });
    expect(traces[0]?.payloadSnapshot?.bundle).toBeNull();
    expect(traces[0]?.exportId).toBeNull();
  });

  it("enables sharing metadata on the first consented vote and upserts subsequent votes", async () => {
    const { companyId, issueId, commentId } = await seedIssueWithAgentComment();

    const first = await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    expect(first.consentEnabledNow).toBe(true);
    expect(first.sharingEnabled).toBe(true);
    expect(first.persistedSharingPreference).toBe("allowed");
    expect(first.vote.sharedWithLabs).toBe(true);
    expect(first.vote.sharedAt).toBeInstanceOf(Date);
    expect(first.vote.consentVersion).toBe("feedback-data-sharing-v1");

    const second = await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "down",
      authorUserId: "user-1",
    });

    expect(second.consentEnabledNow).toBe(false);
    expect(second.sharingEnabled).toBe(false);
    expect(second.persistedSharingPreference).toBeNull();
    expect(second.vote.vote).toBe("down");
    expect(second.vote.sharedWithLabs).toBe(false);
    expect(second.vote.sharedAt).toBeNull();
    expect(second.vote.consentVersion).toBeNull();

    const votes = await svc.listIssueVotesForUser(issueId, "user-1");
    expect(votes).toHaveLength(1);
    expect(votes[0]?.vote).toBe("down");
    expect(votes[0]?.sharedWithLabs).toBe(false);
    expect(votes[0]?.consentVersion).toBeNull();

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    expect(company?.feedbackDataSharingEnabled).toBe(true);
    expect(company?.feedbackDataSharingConsentByUserId).toBe("user-1");
    expect(company?.feedbackDataSharingTermsVersion).toBe("feedback-data-sharing-v1");

    const settings = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .then((rows) => rows[0] ?? null);

    expect(settings?.general).toMatchObject({
      feedbackDataSharingPreference: "allowed",
    });
  });

  it("stores a trace record for document revision feedback targets", async () => {
    const { issueId, revisionId } = await seedIssueWithAgentDocument();

    const result = await svc.saveIssueVote({
      issueId,
      targetType: "issue_document_revision",
      targetId: revisionId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    expect(result.vote.vote).toBe("up");
    expect(result.sharingEnabled).toBe(true);

    const traces = await svc.listFeedbackTraces({
      companyId: result.vote.companyId,
      issueId,
      includePayload: true,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0]?.targetType).toBe("issue_document_revision");
    expect(traces[0]?.status).toBe("pending");
    expect(traces[0]?.targetSummary.documentKey).toBe("plan");
    expect(traces[0]?.targetSummary.revisionNumber).toBe(1);
    expect(traces[0]?.payloadSnapshot?.target).toMatchObject({
      type: "issue_document_revision",
      id: revisionId,
      documentKey: "plan",
      revisionNumber: 1,
    });
  });

  it("stores a downvote reason and includes it in the trace payload", async () => {
    const { issueId, commentId } = await seedIssueWithAgentComment();

    const result = await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "down",
      reason: "The update missed the edge case handling.",
      authorUserId: "user-1",
    });

    expect(result.vote.reason).toBe("The update missed the edge case handling.");

    const traces = await svc.listFeedbackTraces({
      companyId: result.vote.companyId,
      issueId,
      includePayload: true,
    });

    expect(traces[0]?.payloadSnapshot?.vote).toMatchObject({
      value: "down",
      reason: "The update missed the edge case handling.",
      sharedWithLabs: false,
    });
  });

  it("updates an existing downvote reason in place without creating a second trace", async () => {
    const { issueId, commentId } = await seedIssueWithAgentComment();

    const firstResult = await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "down",
      authorUserId: "user-1",
    });

    const secondResult = await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "down",
      reason: "Needed concrete next steps.",
      authorUserId: "user-1",
    });

    expect(secondResult.vote.id).toBe(firstResult.vote.id);
    expect(secondResult.vote.reason).toBe("Needed concrete next steps.");

    const traces = await svc.listFeedbackTraces({
      companyId: secondResult.vote.companyId,
      issueId,
      includePayload: true,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0]?.feedbackVoteId).toBe(firstResult.vote.id);
    expect(traces[0]?.payloadSnapshot?.vote).toMatchObject({
      value: "down",
      reason: "Needed concrete next steps.",
      sharedWithLabs: false,
    });
  });

  it("builds a detailed sanitized shared bundle with issue and agent context", async () => {
    const { companyId, issueId, targetCommentId, runId } = await seedIssueWithRichAgentComment();

    await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: targetCommentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    const traces = await svc.listFeedbackTraces({
      companyId,
      issueId,
      includePayload: true,
    });
    const trace = traces[0];
    const payload = trace?.payloadSnapshot;
    const bundle = payload?.bundle as Record<string, unknown> | null;
    const primaryContent = bundle?.primaryContent as Record<string, unknown> | null;
    const issueContext = bundle?.issueContext as Record<string, unknown> | null;
    const issueContextItems = issueContext?.items as Array<Record<string, unknown>> | undefined;
    const agentContext = bundle?.agentContext as Record<string, unknown> | null;
    const runtime = agentContext?.runtime as Record<string, unknown> | null;
    const sourceRun = runtime?.sourceRun as Record<string, unknown> | null;
    const skills = agentContext?.skills as Record<string, unknown> | null;
    const skillItems = skills?.items as Array<Record<string, unknown>> | undefined;
    const instructions = agentContext?.instructions as Record<string, unknown> | null;

    expect(trace?.status).toBe("pending");
    expect(trace?.exportId).toMatch(/^fbexp_/);
    expect(trace?.schemaVersion).toBe("paperclip-feedback-envelope-v2");
    expect(trace?.bundleVersion).toBe("paperclip-feedback-bundle-v2");
    expect(trace?.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(primaryContent?.createdByRunId).toBe(runId);
    expect(String(primaryContent?.body)).toContain("[REDACTED]");
    expect(String(primaryContent?.body)).not.toContain("secret-value");
    expect(issueContextItems).toHaveLength(2);
    expect(JSON.stringify(issueContextItems)).toContain("[REDACTED_EMAIL]");
    expect(JSON.stringify(issueContextItems)).toContain("[REDACTED_PHONE]");
    expect(sourceRun?.id).toBe(runId);
    expect(JSON.stringify(sourceRun)).toContain("gpt-5.4");
    expect(skillItems?.[1]?.sourceLocator).toBe("https://github.com/octo/research/tree/main/skills/public-skill");
    expect(String(instructions?.entryBody)).toContain("[REDACTED]");
    expect(String(instructions?.entryBody)).not.toContain("secret-value");
  });

  it("keeps earlier local votes local when a later vote enables sharing", async () => {
    const { companyId, issueId, commentId: firstCommentId } = await seedIssueWithAgentComment();
    const secondCommentId = randomUUID();
    const agentId = await db
      .select({ authorAgentId: issueComments.authorAgentId })
      .from(issueComments)
      .where(eq(issueComments.id, firstCommentId))
      .then((rows) => rows[0]?.authorAgentId ?? null);

    await db.insert(issueComments).values({
      id: secondCommentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Second AI generated update",
    });

    await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: firstCommentId,
      vote: "up",
      authorUserId: "user-1",
    });

    await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: secondCommentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    const traces = await svc.listFeedbackTraces({
      companyId,
      issueId,
      includePayload: true,
    });
    const localTrace = traces.find((trace) => trace.targetId === firstCommentId);
    const sharedTrace = traces.find((trace) => trace.targetId === secondCommentId);

    expect(localTrace?.status).toBe("local_only");
    expect(localTrace?.exportId).toBeNull();
    expect(localTrace?.payloadVersion).toBe("paperclip-feedback-v1");
    expect(localTrace?.payloadSnapshot?.bundle).toBeNull();
    expect(sharedTrace?.status).toBe("pending");
    expect(sharedTrace?.exportId).toMatch(/^fbexp_/);
    expect(sharedTrace?.payloadVersion).toBe("paperclip-feedback-v1");
  });

  it("captures Claude project session artifacts as full traces", async () => {
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-feedback-claude-"));
    tempDirs.push(claudeRoot);
    const sessionId = randomUUID();
    const projectDir = path.join(claudeRoot, "projects", "workspace-1");
    fs.mkdirSync(path.join(projectDir, sessionId, "tool-results"), { recursive: true });
    fs.mkdirSync(path.join(claudeRoot, "debug"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          sessionId,
          message: { role: "user", content: "Open AGENTS.md and continue the task." },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/AGENTS.md" } }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, sessionId, "tool-results", "result.txt"),
      "Read tool output with api_key=secret-value",
      "utf8",
    );
    fs.writeFileSync(
      path.join(claudeRoot, "debug", `${sessionId}.txt`),
      "Claude debug log with /Users/dotta/private-workspace and api_key=secret-value",
      "utf8",
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeRoot);
    const uploadTraceBundle = vi.fn().mockResolvedValue({ objectKey: "feedback-traces/test.json" });
    const flushingSvc = feedbackService(db, {
      shareClient: {
        uploadTraceBundle,
      },
    });

    const { issueId, commentId } = await seedIssueWithAdapterRunComment({
      adapterType: "claude_local",
      sessionId,
    });

    await flushingSvc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });
    await flushingSvc.flushPendingFeedbackTraces();

    expect(uploadTraceBundle).toHaveBeenCalledTimes(1);
    const bundle = uploadTraceBundle.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const files = Array.isArray(bundle?.files) ? (bundle.files as Array<Record<string, unknown>>) : [];
    const filePaths = files.map((file) => String(file.path));
    const rawAdapterTrace = bundle?.rawAdapterTrace as Record<string, unknown> | null;

    expect(bundle?.captureStatus).toBe("full");
    expect(filePaths).toContain("adapter/claude/session.jsonl");
    expect(filePaths).toContain("adapter/claude/session/tool-results/result.txt");
    expect(filePaths).toContain("adapter/claude/debug.txt");
    expect(rawAdapterTrace?.projectSessionFound).toBe(true);
    expect(rawAdapterTrace?.projectArtifactsCount).toBe(1);
    expect(rawAdapterTrace?.debugLogFound).toBe(true);
  });

  it("captures OpenCode message and part files as full traces", async () => {
    const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-feedback-opencode-"));
    tempDirs.push(opencodeRoot);
    const sessionId = "ses_test_feedback_trace";
    const sessionDir = path.join(opencodeRoot, "storage", "session", "global");
    const messageDir = path.join(opencodeRoot, "storage", "message", sessionId);
    const partDir = path.join(opencodeRoot, "storage", "part");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(opencodeRoot, "storage", "session_diff"), { recursive: true });
    fs.mkdirSync(messageDir, { recursive: true });
    fs.mkdirSync(path.join(opencodeRoot, "storage", "project"), { recursive: true });
    fs.mkdirSync(path.join(opencodeRoot, "storage", "todo"), { recursive: true });
    const userMessageId = "msg_user_trace";
    const assistantMessageId = "msg_assistant_trace";
    fs.mkdirSync(path.join(partDir, userMessageId), { recursive: true });
    fs.mkdirSync(path.join(partDir, assistantMessageId), { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        projectID: "project-trace",
        title: "Feedback export verification",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(opencodeRoot, "storage", "session_diff", `${sessionId}.json`),
      JSON.stringify([{ op: "replace", path: "/title", value: "Feedback export verification" }]),
      "utf8",
    );
    fs.writeFileSync(
      path.join(messageDir, `${userMessageId}.json`),
      JSON.stringify({
        id: userMessageId,
        sessionID: sessionId,
        role: "user",
        summary: { title: "Continue the issue" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(messageDir, `${assistantMessageId}.json`),
      JSON.stringify({
        id: assistantMessageId,
        sessionID: sessionId,
        role: "assistant",
        finish: "tool-calls",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(partDir, userMessageId, "prt_prompt.json"),
      JSON.stringify({
        id: "prt_prompt",
        sessionID: sessionId,
        messageID: userMessageId,
        type: "text",
        text: "Open AGENTS.md and continue the task.",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(partDir, assistantMessageId, "prt_tool.json"),
      JSON.stringify({
        id: "prt_tool",
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/tmp/AGENTS.md" },
          output: "api_key=secret-value",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(opencodeRoot, "storage", "project", "project-trace.json"),
      JSON.stringify({
        id: "project-trace",
        worktree: "/Users/dotta/project",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(opencodeRoot, "storage", "todo", `${sessionId}.json`),
      JSON.stringify([{ content: "Verify exported traces" }]),
      "utf8",
    );
    vi.stubEnv("PAPERCLIP_OPENCODE_STORAGE_DIR", opencodeRoot);
    const uploadTraceBundle = vi.fn().mockResolvedValue({ objectKey: "feedback-traces/test.json" });
    const flushingSvc = feedbackService(db, {
      shareClient: {
        uploadTraceBundle,
      },
    });

    const { issueId, commentId } = await seedIssueWithAdapterRunComment({
      adapterType: "opencode_local",
      sessionId,
    });

    await flushingSvc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });
    await flushingSvc.flushPendingFeedbackTraces();

    expect(uploadTraceBundle).toHaveBeenCalledTimes(1);
    const bundle = uploadTraceBundle.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const files = Array.isArray(bundle?.files) ? (bundle.files as Array<Record<string, unknown>>) : [];
    const filePaths = files.map((file) => String(file.path));
    const rawAdapterTrace = bundle?.rawAdapterTrace as Record<string, unknown> | null;

    expect(bundle?.captureStatus).toBe("full");
    expect(filePaths).toContain("adapter/opencode/session.json");
    expect(filePaths).toContain("adapter/opencode/session-diff.json");
    expect(filePaths).toContain(`adapter/opencode/messages/${userMessageId}.json`);
    expect(filePaths).toContain(`adapter/opencode/parts/${assistantMessageId}/prt_tool.json`);
    expect(filePaths).toContain("adapter/opencode/project.json");
    expect(filePaths).toContain("adapter/opencode/todo.json");
    expect(rawAdapterTrace?.messageFilesCount).toBe(2);
    expect(rawAdapterTrace?.partFilesCount).toBe(2);
  });

  it("rejects feedback votes on human-authored comments", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Human-authored comment",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "user-2",
      body: "Board comment",
    });

    await expect(
      svc.saveIssueVote({
        issueId,
        targetType: "issue_comment",
        targetId: commentId,
        vote: "up",
        authorUserId: "user-1",
      }),
    ).rejects.toThrow("Feedback voting is only available on agent-authored issue comments");
  });

  it("flushes pending shared traces into configured object storage and marks them sent", async () => {
    const { companyId, issueId, commentId } = await seedIssueWithAgentComment();
    const uploadTraceBundle = vi.fn().mockResolvedValue({
      objectKey: `feedback-traces/${companyId}/2026/04/01/test-trace.json`,
    });
    const flushingSvc = feedbackService(db, {
      shareClient: {
        uploadTraceBundle,
      },
    });

    await flushingSvc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    const flushResult = await flushingSvc.flushPendingFeedbackTraces();
    expect(flushResult).toMatchObject({
      attempted: 1,
      sent: 1,
      failed: 0,
    });

    const traces = await flushingSvc.listFeedbackTraces({
      companyId,
      issueId,
      includePayload: true,
    });
    expect(traces[0]?.status).toBe("sent");
    expect(traces[0]?.attemptCount).toBe(1);
    expect(traces[0]?.exportedAt).toBeInstanceOf(Date);
    expect(traces[0]?.failureReason).toBeNull();
    expect(uploadTraceBundle).toHaveBeenCalledTimes(1);
    expect(uploadTraceBundle.mock.calls[0]?.[0]).toMatchObject({
      traceId: traces[0]?.id,
      exportId: traces[0]?.exportId,
      companyId,
      issueId,
      issueIdentifier: traces[0]?.issueIdentifier,
      captureStatus: expect.stringMatching(/^(full|partial|unavailable)$/),
      envelope: {
        destination: "paperclip_labs_feedback_v1",
        exportId: traces[0]?.exportId,
      },
    });
  });

  it("can flush a single shared trace immediately by trace id", async () => {
    const { companyId, issueId, commentId: firstCommentId } = await seedIssueWithAgentComment();
    const secondCommentId = randomUUID();
    const agentId = await db
      .select({ authorAgentId: issueComments.authorAgentId })
      .from(issueComments)
      .where(eq(issueComments.id, firstCommentId))
      .then((rows) => rows[0]?.authorAgentId ?? null);

    await db.insert(issueComments).values({
      id: secondCommentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Second AI generated update",
    });

    const uploadTraceBundle = vi.fn().mockResolvedValue({
      objectKey: `feedback-traces/${companyId}/2026/04/01/test-trace.json`,
    });
    const flushingSvc = feedbackService(db, {
      shareClient: {
        uploadTraceBundle,
      },
    });

    const first = await flushingSvc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: firstCommentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });
    await flushingSvc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: secondCommentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    const flushResult = await flushingSvc.flushPendingFeedbackTraces({
      companyId,
      traceId: first.traceId ?? undefined,
      limit: 1,
    });

    expect(flushResult).toMatchObject({
      attempted: 1,
      sent: 1,
      failed: 0,
    });
    expect(uploadTraceBundle).toHaveBeenCalledTimes(1);

    const traces = await flushingSvc.listFeedbackTraces({
      companyId,
      issueId,
      includePayload: true,
    });
    const firstTrace = traces.find((trace) => trace.targetId === firstCommentId);
    const secondTrace = traces.find((trace) => trace.targetId === secondCommentId);
    expect(firstTrace?.status).toBe("sent");
    expect(secondTrace?.status).toBe("pending");
  });

  it("marks pending shared traces as failed when remote export upload fails", async () => {
    const { companyId, issueId, commentId } = await seedIssueWithAgentComment();
    const uploadTraceBundle = vi.fn().mockRejectedValue(new Error("telemetry unavailable"));
    const flushingSvc = feedbackService(db, {
      shareClient: {
        uploadTraceBundle,
      },
    });

    await flushingSvc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    const flushResult = await flushingSvc.flushPendingFeedbackTraces();
    expect(flushResult).toMatchObject({
      attempted: 1,
      sent: 0,
      failed: 1,
    });

    const traces = await flushingSvc.listFeedbackTraces({
      companyId,
      issueId,
      includePayload: true,
    });
    expect(traces[0]?.status).toBe("failed");
    expect(traces[0]?.attemptCount).toBe(1);
    expect(traces[0]?.lastAttemptedAt).toBeInstanceOf(Date);
    expect(traces[0]?.failureReason).toContain("telemetry unavailable");
    expect(traces[0]?.exportedAt).toBeNull();
    expect(uploadTraceBundle).toHaveBeenCalledTimes(1);
  });

  it("marks pending shared traces as failed when no feedback export backend is configured", async () => {
    const { companyId, issueId, commentId } = await seedIssueWithAgentComment();

    const result = await svc.saveIssueVote({
      issueId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "up",
      authorUserId: "user-1",
      allowSharing: true,
    });

    const flushResult = await svc.flushPendingFeedbackTraces({
      companyId,
      traceId: result.traceId ?? undefined,
      limit: 1,
    });

    expect(flushResult).toMatchObject({
      attempted: 1,
      sent: 0,
      failed: 1,
    });

    const traces = await svc.listFeedbackTraces({
      companyId,
      issueId,
      includePayload: true,
    });
    expect(traces[0]?.status).toBe("failed");
    expect(traces[0]?.attemptCount).toBe(1);
    expect(traces[0]?.failureReason).toBe("Feedback export backend is not configured");
    expect(traces[0]?.exportedAt).toBeNull();
  });
});

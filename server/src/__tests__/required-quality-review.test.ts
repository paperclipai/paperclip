import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, assets, companies, createDb, documents, heartbeatRuns, issueAttachments, issueThreadInteractionIdempotencyKeys, issueThreadInteractions, issues } from "@paperclipai/db";
import { requiredQualityReviewSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { readRequiredQualityReview } from "../services/required-quality-review.js";
import { nativeCompletionFeedback } from "../services/native-runtime/native-completion-feedback.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import type { PrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";

const requirement = { version: 1 as const, deliverables: [{ key: "copy", label: "Blog copy" }, { key: "visual", label: "Supporting visual" }] };
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit required output quality review", () => {
  let db: ReturnType<typeof createDb>, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("required-quality-review-"); db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false, enableAgentChat: true }); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function fixture(required = true) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = "local-board";
    await db.insert(companies).values({ id: companyId, name: "Quality", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", status: "idle", adapterType: "paperclip_runner" });
    const [task] = await db.insert(issues).values({ id: issueId, companyId, title: "Review outputs", status: "in_progress", assigneeAgentId: agentId,
      createdByUserId: userId, reviewPolicy: null,
      executionPolicy: required ? normalizeIssueExecutionPolicy({ requiredQualityReview: requirement }) : null }).returning();
    const saved = await documentService(db).upsertIssueDocument({ issueId, key: "copy", title: "Blog copy", body: "Draft one", format: "markdown", baseRevisionId: null, createdByUserId: userId });
    const copy = { type: "issue_document" as const, key: "copy", revisionId: saved.document.latestRevisionId! };
    const assetId = randomUUID(), attachmentId = randomUUID(), sha256 = "a".repeat(64);
    await db.insert(assets).values({ id: assetId, companyId, provider: "local_disk", objectKey: assetId, contentType: "image/png", byteSize: 100, sha256, originalFilename: "visual.png", createdByUserId: userId });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId, issueId, assetId });
    const visual = { type: "issue_attachment" as const, attachmentId, assetId, sha256 };
    const service = issueThreadInteractionService(db);
    const approve = async (key: "copy" | "visual", target = key === "copy" ? copy : visual) => {
      const card = await service.create(task, { kind: "request_confirmation", idempotencyKey: randomUUID(), payload: { version: 1, prompt: "Approve this output?", target, qualityReview: { key } } }, { userId });
      await service.acceptInteraction(task, card.id, {}, { userId }); return card;
    };
    return { task, companyId, agentId, issueId, userId, saved, copy, visual, service, approve };
  }
  it("retains the optional policy and validates unique required output keys", () => {
    expect(normalizeIssueExecutionPolicy({ requiredQualityReview: requirement })?.requiredQualityReview).toEqual(requirement);
    expect(normalizeIssueExecutionPolicy({})).toBeNull();
    expect(requiredQualityReviewSchema.safeParse({ version: 1, deliverables: [requirement.deliverables[0], requirement.deliverables[0]] }).success).toBe(false);
  });
  it("does not gate existing tasks without the opt-in requirement", async () => {
    const f = await fixture(false);
    expect(await readRequiredQualityReview(db, f.task)).toEqual({ required: false, satisfied: true, missing: [] });
    expect(await issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId })).toMatchObject({ status: "done" });
  });
  it("rejects completion from file presence and unrelated accepted plan/confirmation", async () => {
    const f = await fixture();
    const unrelated = await f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Accept plan?", target: f.copy } }, { userId: f.userId });
    await f.service.acceptInteraction(f.task, unrelated.id, {}, { userId: f.userId });
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: false, missing: [{ key: "copy", reason: "missing" }, { key: "visual", reason: "missing" }] });
    await expect(issueService(db).create(f.companyId, { title: "Bypass review at creation", status: "done", executionPolicy: f.task.executionPolicy })).rejects.toThrow("cannot start completed");
    await expect(issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId })).rejects.toMatchObject({ details: { code: "required_quality_review_incomplete" } });
    await expect(f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve plan?", qualityReview: { key: "copy" }, target: { ...f.copy, key: "plan" } } }, { userId: f.userId })).rejects.toThrow("not a plan");
  });
  it("accepts exact canonical human quality approvals without publishing or completing automatically", async () => {
    const f = await fixture(); await f.approve("copy"); await f.approve("visual");
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: true });
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId)); expect(before.status).toBe("in_progress");
    expect(await issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId })).toMatchObject({ status: "done" });
  });
  it("protects accepted requirements from agent removal or weakening and permits audited human edits", async () => {
    const f = await fixture();
    for (const executionPolicy of [null, normalizeIssueExecutionPolicy({ requiredQualityReview: { version: 1, deliverables: [requirement.deliverables[0]] } })]) {
      await expect(issueService(db).update(f.issueId, { executionPolicy, actorAgentId: f.agentId })).rejects.toThrow("Only a human");
    }
    expect(await issueService(db).update(f.issueId, { executionPolicy: null, actorUserId: f.userId })).toMatchObject({ executionPolicy: null });
  });
  it("requires reopening before adding an unsatisfied review contract to an already-completed task", async () => {
    const f = await fixture(false), service = issueService(db);
    await service.update(f.issueId, { status: "done", actorAgentId: f.agentId });
    const executionPolicy = normalizeIssueExecutionPolicy({ requiredQualityReview: requirement });
    await expect(service.update(f.issueId, { executionPolicy, actorUserId: f.userId })).rejects.toMatchObject({ details: { code: "required_quality_review_incomplete" } });
    expect(await service.update(f.issueId, { status: "todo", executionPolicy, actorUserId: f.userId })).toMatchObject({ status: "todo", executionPolicy: { requiredQualityReview: requirement } });
  });
  it("does not silently drop a required review when reusing an open task by title or idempotency key", async () => {
    const f = await fixture(false), service = issueService(db);
    await expect(service.create(f.companyId, { title: f.task.title, allowDuplicate: false, executionPolicy: normalizeIssueExecutionPolicy({ requiredQualityReview: requirement }) })).rejects.toMatchObject({ details: { code: "required_quality_review_mismatch" } });
    const child = await service.createChild(f.issueId, { title: "Existing child", idempotencyKey: "same-child" });
    await expect(service.createChild(f.issueId, { title: "Existing child", idempotencyKey: "same-child", executionPolicy: normalizeIssueExecutionPolicy({ requiredQualityReview: requirement }) })).rejects.toMatchObject({ details: { code: "required_quality_review_mismatch" } });
    expect(child.issue.executionPolicy).toBeNull();
  });
  it("rejects stale revisions, removed attachments and changed requirement identities", async () => {
    const f = await fixture(); await f.approve("copy"); await f.approve("visual");
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy", body: "Changed copy", format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: false, missing: [{ key: "copy", reason: "stale" }] });
    await db.delete(issueAttachments).where(eq(issueAttachments.id, f.visual.attachmentId));
    expect((await readRequiredQualityReview(db, f.task)).missing.map(item => item.key)).toEqual(["copy", "visual"]);
    const changed = { ...f.task, executionPolicy: normalizeIssueExecutionPolicy({ requiredQualityReview: { ...requirement, deliverables: [{ key: "copy", label: "Revised scope" }, requirement.deliverables[1]] } }) };
    expect((await readRequiredQualityReview(db, changed)).missing.every(item => item.reason === "stale")).toBe(true);
  });
  it("evaluates each item verdict: copy rejection cannot be masked by visual approval or answered status", async () => {
    const f = await fixture();
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", resolverPolicy: "anyone", payload: { version: 1, prompt: "Review copy and visual", items: [
      { id: "copy", label: "Copy", qualityReview: { key: "copy", requirementHash: "f".repeat(64) }, target: f.copy },
      { id: "visual", label: "Visual", qualityReview: { key: "visual" }, target: f.visual },
    ] } }, { userId: f.userId });
    await expect(f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Ambiguous output", items: [
      { id: "first", label: "Approved copy", qualityReview: { key: "copy" }, target: f.copy },
      { id: "second", label: "Rejected copy", qualityReview: { key: "copy" }, target: f.copy },
    ] } }, { userId: f.userId })).rejects.toThrow("Quality review keys must be unique");
    expect(card.effectiveResolverPolicy).toBe("human_only");
    await expect(f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "approve" }] }, { agentId: f.agentId, runId: randomUUID() })).rejects.toThrow();
    await f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "reject", reason: "Rewrite the opening" }, { id: "visual", verdict: "approve" }] }, { userId: f.userId });
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: false, missing: [{ key: "copy", reason: "not_approved" }] });
    await f.approve("copy"); expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: true });
  });
  it.each(["document", "attachment"])("refuses an ordinary item-review batch when its %s target becomes stale", async stale => {
    const f = await fixture(false);
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", target: f.copy }, { id: "visual", label: "Visual", target: f.visual },
    ] } }, { userId: f.userId });
    if (stale === "document") {
      await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy", body: "Changed copy",
        format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    } else {
      await db.delete(issueAttachments).where(eq(issueAttachments.id, f.visual.attachmentId));
    }
    await expect(f.service.submitItemVerdicts(f.task, card.id, { verdicts: [
      { id: "copy", verdict: "approve" }, { id: "visual", verdict: "approve" },
    ] }, { userId: f.userId })).rejects.toMatchObject({ status: 422 });
    const saved = await f.service.getForIssue(f.task, card.id);
    expect(saved?.status).toBe("pending");
    expect(saved?.result).toBeNull();
  });
  it("records ordinary item verdicts when both bound outputs are still current", async () => {
    const f = await fixture(false);
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", target: f.copy }, { id: "visual", label: "Visual", target: f.visual },
    ] } }, { userId: f.userId });
    const saved = await f.service.submitItemVerdicts(f.task, card.id, { verdicts: [
      { id: "copy", verdict: "approve" }, { id: "visual", verdict: "approve" },
    ] }, { userId: f.userId });
    expect(saved.interaction.status).toBe("answered");
    expect(saved.newlyResolvedItemIds).toEqual(["copy", "visual"]);
  });
  it("stamps quality bindings before idempotent replay and rejects cross-task targets", async () => {
    const f = await fixture(), other = await fixture();
    const request = { kind: "request_confirmation" as const, idempotencyKey: "same", payload: { version: 1 as const, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } };
    const first = await f.service.create(f.task, request, { userId: f.userId });
    expect((await f.service.create(f.task, request, { userId: f.userId })).id).toBe(first.id);
    await expect(f.service.create(f.task, { ...request, idempotencyKey: "cross", payload: { ...request.payload, target: { ...other.copy, issueId: other.issueId } } }, { userId: f.userId })).rejects.toThrow("on this task");
  });
  it("reuses repeated agent quality requests with fresh idempotency keys and keeps distinct outputs actionable", async () => {
    const f = await fixture();
    const actor = { agentId: f.agentId };
    const request = { kind: "request_confirmation" as const, addresseeUserId: f.userId,
      payload: { version: 1 as const, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } };
    await expect(f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Duplicate slots", items: [
      { id: "first", label: "Copy one", qualityReview: { key: "copy" }, target: f.copy },
      { id: "second", label: "Copy two", qualityReview: { key: "copy" }, target: f.copy },
    ] } }, actor)).rejects.toThrow("Quality review keys must be unique");
    const first = await f.service.create(f.task, { ...request, idempotencyKey: randomUUID() }, actor);
    const retryKeys = Array.from({ length: 12 }, () => randomUUID());
    const repeats = await Promise.all(retryKeys.map(idempotencyKey => f.service.create(f.task, { ...request, idempotencyKey }, actor)));
    expect(new Set(repeats.map(card => card.id))).toEqual(new Set([first.id]));
    const visual = await f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve visual?", target: f.visual, qualityReview: { key: "visual" } } }, actor);
    await expect(f.service.create(f.task, { ...request, payload: { ...request.payload, prompt: "Another copy request" } }, actor)).rejects.toMatchObject({ details: { code: "quality_review_already_pending", interactionId: first.id } });
    await expect(f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Duplicate copy", items: [{ id: "copy", label: "Copy", qualityReview: { key: "copy" }, target: f.copy }] } }, actor)).rejects.toMatchObject({ details: { code: "quality_review_already_pending" } });
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(rows.filter(row => row.status === "pending").map(row => row.id).sort()).toEqual([first.id, visual.id].sort());
    await f.service.acceptInteraction(f.task, first.id, {}, { userId: f.userId });
    const replay = await f.service.create(f.task, { ...request, idempotencyKey: retryKeys[0] }, actor);
    expect(replay).toMatchObject({ id: first.id, status: "accepted" });
    await expect(f.service.create(f.task, { ...request, idempotencyKey: retryKeys[0], payload: { ...request.payload, prompt: "Changed request" } }, actor)).rejects.toMatchObject({ status: 409 });
    expect((await readRequiredQualityReview(db, f.task)).missing.map(item => item.key)).toEqual(["visual"]);
    const aliases = await db.select().from(issueThreadInteractionIdempotencyKeys).where(eq(issueThreadInteractionIdempotencyKeys.interactionId, first.id));
    expect(aliases.map(alias => alias.idempotencyKey).sort()).toEqual(retryKeys.sort());
    // Replaying the additive migration after a rebase must retain these durable
    // acknowledgements and their FK/index protections.
    const migrations = new URL("../../../packages/db/src/migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql"))) {
      const source = await readFile(new URL(file, migrations), "utf8");
      if (!source.includes('CREATE TABLE IF NOT EXISTS "issue_thread_interaction_idempotency_keys"')) continue;
      for (const statement of source.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await db.execute(sql.raw(statement));
    }
    expect(await f.service.create(f.task, { ...request, idempotencyKey: retryKeys[0] }, actor)).toMatchObject({ id: first.id, status: "accepted" });
    expect((await f.service.create(f.task, { ...request, idempotencyKey: randomUUID() }, actor)).id).not.toBe(first.id);
  });
  it("bounds acknowledged retry keys while preserving already-acknowledged replay", async () => {
    const f = await fixture();
    const request = { kind: "request_confirmation" as const, idempotencyKey: "original", payload: { version: 1 as const, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } };
    const actor = { agentId: f.agentId };
    const first = await f.service.create(f.task, request, actor);
    await db.insert(issueThreadInteractionIdempotencyKeys).values(Array.from({ length: 100 }, (_, index) => ({ companyId: f.companyId, issueId: f.issueId, interactionId: first.id, idempotencyKey: `retry-${index}` })));
    await expect(f.service.create(f.task, { ...request, idempotencyKey: "one-too-many" }, actor)).rejects.toMatchObject({ details: { code: "quality_review_retry_key_limit", interactionId: first.id } });
    await f.service.acceptInteraction(f.task, first.id, {}, { userId: f.userId });
    expect(await f.service.create(f.task, { ...request, idempotencyKey: "retry-99" }, actor)).toMatchObject({ id: first.id, status: "accepted" });
    expect(await f.service.create(f.task, request, actor)).toMatchObject({ id: first.id, status: "accepted" });
  });
  it("allows a fresh review for an answered item while another output in its batch remains pending", async () => {
    const f = await fixture();
    const batch = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", qualityReview: { key: "copy" }, target: f.copy },
      { id: "visual", label: "Visual", qualityReview: { key: "visual" }, target: f.visual },
    ] } }, { agentId: f.agentId });
    await f.service.submitItemVerdicts(f.task, batch.id, { verdicts: [{ id: "copy", verdict: "reject", reason: "Revise opening" }] }, { userId: f.userId });
    const next = await f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Review copy again", qualityReview: { key: "copy" }, target: f.copy } }, { agentId: f.agentId });
    expect(next.id).not.toBe(batch.id);
    await expect(f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Duplicate visual", qualityReview: { key: "visual" }, target: f.visual } }, { agentId: f.agentId })).rejects.toMatchObject({ details: { code: "quality_review_already_pending", interactionId: batch.id } });
  });
  it("caps pending quality cards task-wide even when previous requirement keys or reviewers differ", async () => {
    const f = await fixture();
    await db.insert(issueThreadInteractions).values(Array.from({ length: 10 }, (_, i) => ({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Prior required output", target: f.copy, qualityReview: { key: `prior-${i}`, requirementHash: "a".repeat(64) } },
    })));
    await expect(f.service.create(f.task, { kind: "request_confirmation", addresseeUserId: f.userId, payload: { version: 1, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } }, { agentId: f.agentId })).rejects.toMatchObject({ details: { code: "quality_review_pending_limit" } });
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(rows).toHaveLength(10);
  });
  it("locks the task before a verdict output and rechecks closure after a concurrent task transition", async () => {
    const f = await fixture();
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", qualityReview: { key: "copy" }, target: f.copy },
      { id: "visual", label: "Visual", qualityReview: { key: "visual" }, target: f.visual },
    ] } }, { userId: f.userId });
    await f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "approve" }] }, { userId: f.userId });
    let submission: ReturnType<typeof f.service.submitItemVerdicts> | undefined;
    let observed: { wait_event_type: string; query: string } | undefined;
    await db.transaction(async tx => {
      await tx.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      let resolvePid!: (value: number) => void;
      const pidReady = new Promise<number>(resolve => { resolvePid = resolve; });
      submission = f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "approve" }] }, { userId: f.userId }, {
        beforeResolveInTransaction: async inner => {
          const rows = await inner.execute(sql`select pg_backend_pid() as pid`);
          resolvePid(Number(rows[0].pid));
        },
      });
      // Register rejection handling before releasing the concurrent task lock.
      void submission.catch(() => undefined);
      const pid = await pidReady;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute(sql`select wait_event_type, query from pg_stat_activity where pid = ${pid}`);
        const row = rows[0] as typeof observed;
        if (row?.wait_event_type === "Lock") { observed = row; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await expect(submission).rejects.toMatchObject({ details: { code: "interaction_issue_closed" } });
    expect(observed?.query).toContain('from "issues"');
    expect(observed?.query).not.toContain('from "issue_thread_interactions"');
    expect(observed?.query).not.toContain('from "documents"');
  });
  it("carries the requirement through suggestion acceptance atomically", async () => {
    const f = await fixture(false);
    const suggestion = await f.service.create(f.task, { kind: "suggest_tasks", payload: { version: 1, tasks: [{ clientKey: "blog", title: "Blog", requiredQualityReview: requirement }] } }, { userId: f.userId });
    const accepted = await f.service.acceptSuggestedTasks(f.task, suggestion.id, {}, { userId: f.userId });
    const [child] = await db.select().from(issues).where(eq(issues.id, accepted.createdIssues[0]!.id));
    expect(child).toMatchObject({ reviewPolicy: null, executionPolicy: { requiredQualityReview: requirement } });
  });
  it("carries the same contract through native explicit task creation without waking a provider", async () => {
    const f = await fixture(false), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId, workMode: "standard", enqueueWakeup: async () => null });
    const result = await authority.execute({ tool: "create_task", callId: "create", arguments: { idempotencyKey: "create", title: "Write approved blog", requiredQualityReview: requirement } }) as { task: { id: string } };
    const [child] = await db.select().from(issues).where(eq(issues.id, result.task.id));
    expect(child).toMatchObject({ reviewPolicy: null, executionPolicy: { requiredQualityReview: requirement } });
  });
  it.each(["confirmation", "item_verdicts"] as const)("preserves exact quality binding through the advertised native %s tool", async interactionKind => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId, workMode: "standard", enqueueWakeup: async () => null });
    const definition = authority.definitions().find(tool => tool.name === "request_human_input")!;
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
    const validate = ajv.compile(definition.inputSchema as object);
    for (const [key, target] of [["copy", f.copy], ["visual", f.visual]] as const) {
      const input = { idempotencyKey: `native-${key}`, interactionKind, title: `Review ${key}`, prompt: "Approve this output?", resolverPolicy: "human_only", continuationPolicy: "wake_assignee", payload: {
        version: 1, supersedeOnUserComment: false,
        ...(interactionKind === "confirmation" ? { qualityReview: { key }, target } : { items: [{ id: key, label: key, qualityReview: { key }, target }] }),
      } };
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...input, supersedeOnUserComment: false })).toBe(false);
      const result = await authority.execute({ tool: "request_human_input", callId: key, arguments: input }) as { interaction: { id: string; payload: any; effectiveResolverPolicy: string } };
      expect(result.interaction.effectiveResolverPolicy).toBe("human_only");
      const item = interactionKind === "confirmation" ? result.interaction.payload : result.interaction.payload.items[0];
      expect(item).toMatchObject({ qualityReview: { key, requirementHash: expect.stringMatching(/^[a-f0-9]{64}$/) }, target });
      const replay = await authority.execute({ tool: "request_human_input", callId: `${key}-retry`, arguments: input }) as typeof result;
      expect(replay.interaction.id).toBe(result.interaction.id);
      if (interactionKind === "confirmation") await f.service.acceptInteraction(f.task, result.interaction.id, {}, { userId: f.userId });
      else await f.service.submitItemVerdicts(f.task, result.interaction.id, { verdicts: [{ id: key, verdict: "approve" }] }, { userId: f.userId });
    }
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: true });
  });
  it("rejects a native done claim until required output approvals exist", async () => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const done: PrpStructuredRunResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Outputs ready", completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    await expect(nativeCompletionFeedback(db, runId, done)).rejects.toThrow("Required human quality review is incomplete");
    await f.approve("copy"); await f.approve("visual");
    await expect(nativeCompletionFeedback(db, runId, done)).resolves.toContain("Completion report accepted");
  });
});

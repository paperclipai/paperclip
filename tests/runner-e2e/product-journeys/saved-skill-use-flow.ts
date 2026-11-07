import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { collectRunEvents } from "../run-observations.js";
import { createTaskThroughUi } from "../user-actions.js";
import { validateAgentTaskState, waitFor } from "./agent-flows.js";
import { createObservedReader } from "./observation-read.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { savedSkillDocumentAttributed, savedSkillFixture, savedSkillReadAssignment, savedSkillReadReceipts, savedSkillReadRuntimeName, savedSkillSourceMatches } from "./saved-skill-use-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const id = "saved-skill-use";

export async function runSavedSkillUse(context: JourneyContext, session: TargetSession, campaignId: string,
  evidence: JourneyEvidence, options: { deadlineAt: number; directory: string }) {
  const agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId)
    throw new JourneyError("unsupported", "native_agent_and_environment_required");
  if (!context.capabilities.includes("skill-write")) throw new JourneyError("unsupported", "missing_skill_write");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const read = createObservedReader(context.api, options.deadlineAt);
  const fixture = savedSkillFixture(campaignId, randomBytes(16).toString("hex"));
  const title = `Journey QA saved skill ${campaignId}`;
  const prompt = `Use /${fixture.slug} for this task. Follow that saved skill's procedure, verify its saved result, and finish. `
    + "Do not create child tasks or unrelated deliverables.";
  const check = (name: string, passed: boolean) => {
    evidence.checks.push({ id: name, passed });
    if (!passed) throw new JourneyError("failed", name.replaceAll("-", "_"));
  };
  let checkpoint: Row = { fixture };
  let primaryFailure: unknown;
  try {
    const companyRoute = `/api/companies/${context.company.id}`;
    await session.own({ kind: "skill", name: fixture.name, journeyId: id });
    const createdSkill = await context.api.post<Row>(`${companyRoute}/skills`, {
      name: fixture.name, slug: fixture.slug, description: "Make a receipt using this saved procedure.",
      markdown: fixture.markdown, idempotencyKey: `saved-skill-${campaignId}`,
    });
    if (!createdSkill?.id) throw new JourneyError("failed", "saved_skill_creation_receipt_missing");
    await session.own({ kind: "skill", name: fixture.name, id: createdSkill.id, journeyId: id });
    checkpoint = { ...checkpoint, createdSkill };
    const skillRoute = `${companyRoute}/skills/${createdSkill.id}`;
    const skill = await read.get<Row>(skillRoute);
    if (!skill?.key || !skill.currentVersionId) throw new JourneyError("failed", "saved_skill_version_missing");
    if (skill.id !== createdSkill.id || !createdSkill.currentVersionId || skill.currentVersionId !== createdSkill.currentVersionId)
      throw new JourneyError("failed", "saved_skill_created_version_mismatch");
    await context.api.post(`/api/agents/${agent.id}/skills/sync?companyId=${context.company.id}`, {
      desiredSkills: [skill.key], mode: "add",
    });
    const assignmentRoute = `/api/agents/${agent.id}/skills?companyId=${context.company.id}`;
    const versionRoute = `${skillRoute}/versions/${skill.currentVersionId}`;
    const [version, assignments, beforeDispatchSkill] = await Promise.all([
      read.get<Row>(versionRoute), read.get<Row>(assignmentRoute), read.get<Row>(skillRoute),
    ]);
    checkpoint = { ...checkpoint, skill, version, assignments, beforeDispatchSkill };
    check("saved-skill-assignment-bound", beforeDispatchSkill.id === createdSkill.id
      && beforeDispatchSkill.currentVersionId === createdSkill.currentVersionId
      && savedSkillSourceMatches(beforeDispatchSkill, version, assignments, fixture, context.company.id));

    const created = await createTaskThroughUi({ page: context.page, origin: context.api.origin,
      issuePrefix: context.company.issuePrefix, agentName: agent.name, title, prompt, workMode: "standard", requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: title, journeyId: id }) });
    await session.own({ kind: "issue", name: title, id: created.issueId, journeyId: id });
    const route = `/api/issues/${created.issueId}`;
    const state = await waitFor(options.deadlineAt, async () => {
      const [currentIssue, summaries, comments, interactions] = await Promise.all([
        read.get<Row & { id: string; status: string }>(route), read.get<Row[]>(`${route}/runs`),
        read.get<Row[]>(`${route}/comments?order=asc`), read.get<Array<Row & { id: string; status: string }>>(`${route}/interactions`),
      ]);
      if (!Array.isArray(summaries) || summaries.length > 1) throw new JourneyError("failed", "saved_skill_run_limit_exceeded");
      const taskRuns = await Promise.all(summaries.map(row => read.get<Row & { status: string }>(`/api/heartbeat-runs/${row.runId}`)));
      const value = { currentIssue, taskRuns, comments, interactions, attachments: [] };
      validateAgentTaskState(context, created.issueId, value, 1);
      checkpoint = { ...checkpoint, state: value };
      return value;
    }, value => value.currentIssue.status === "done" && value.taskRuns.length === 1 && value.taskRuns[0]!.status === "succeeded"
      && value.taskRuns[0]!.nativePhase === "committed"
      && value.interactions.every(row => row.status !== "pending"), "saved_skill_task_not_completed");
    const admittedVersions = state.taskRuns[0]!.contextSnapshot?.skillVersions;
    if (state.taskRuns[0]!.contextSnapshot?.skillSelectionSnapshot !== true || !admittedVersions
      || typeof admittedVersions !== "object" || Array.isArray(admittedVersions)
      || !Object.hasOwn(admittedVersions, skill.key) || admittedVersions[skill.key] !== version.id)
      throw new JourneyError("failed", "saved_skill_run_version_mismatch");
    const binding = { companyId: context.company.id, agentId: agent.id, runId: state.taskRuns[0]!.id, issueId: created.issueId };
    const request = String(state.currentIssue.description ?? "");
    check("saved-skill-input-only-in-source", request.includes(`/${fixture.slug}`) && !request.includes(fixture.expected.reference)
      && !state.comments.some(row => row.authorUserId && String(row.body ?? "").includes(fixture.expected.reference)));
    const events = await collectRunEvents<Row>(
      (afterSeq, limit) => read.get(`/api/heartbeat-runs/${binding.runId}/events?afterSeq=${afterSeq}&limit=${limit}`));
    const runtimeName = savedSkillReadRuntimeName(skill, assignments, state.taskRuns[0]!);
    const assignment = savedSkillReadAssignment(skill, assignments, state.taskRuns[0]!);
    const receipts = savedSkillReadReceipts(events, binding, fixture, runtimeName, assignment, state.taskRuns[0]!);
    checkpoint = { ...checkpoint, events, receipts };
    check("saved-skill-native-read-attributed", receipts.length > 0);
    const documents = await read.get<Row[]>(`${route}/documents`);
    if (documents.length !== 1 || documents[0]?.key !== fixture.key) throw new JourneyError("failed", "saved_skill_unexpected_documents");
    const documentRoute = `${route}/documents/${fixture.key}`;
    const document = await read.get<Row>(documentRoute);
    const revision = await read.get<Row>(`${documentRoute}/revisions/${document.latestRevisionId}`);
    checkpoint = { ...checkpoint, document, revision };
    check("saved-skill-result-authored-by-run", savedSkillDocumentAttributed(document, revision, fixture, binding));
    const url = `${context.api.origin}/${context.company.issuePrefix}/issues/${state.currentIssue.identifier ?? created.issueId}`;
    await context.page.goto(url, { waitUntil: "domcontentloaded" });
    await context.page.reload();
    await openDocumentAuthoring(context);
    await expect(context.page.locator(`#document-${fixture.key}`)).toContainText(fixture.expected.reference);
    const [reopened, retainedSkill, retainedVersion, retainedAssignments] = await Promise.all([
      read.get<Row>(documentRoute), read.get<Row>(skillRoute), read.get<Row>(versionRoute), read.get<Row>(assignmentRoute),
    ]);
    checkpoint = { ...checkpoint, reopened, retainedSkill, retainedVersion, retainedAssignments };
    check("saved-skill-result-reopened", reopened.latestRevisionId === document.latestRevisionId
      && savedSkillDocumentAttributed(reopened, revision, fixture, binding));
    check("saved-skill-source-preserved", savedSkillSourceMatches(retainedSkill, retainedVersion, retainedAssignments, fixture, context.company.id)
      && retainedSkill.id === skill.id && retainedSkill.currentVersionId === skill.currentVersionId);
    check("configured-model-and-environment", true); // All observed runs were independently validated above.
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await writeFile(path.join(options.directory, "saved-skill-use-checks.json"), JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
      await read.preserve(options.directory);
    } catch (error) {
      if (!primaryFailure) throw error;
    }
  }
}

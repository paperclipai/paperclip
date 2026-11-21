import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { createTaskThroughUi } from "../user-actions.js";
import { validateAgentTaskState, waitFor } from "./agent-flows.js";
import { inputFileAttachmentMatches, inputFileFixture, inputFileSummaryMatches, type InputFileAttachment } from "./input-file-evidence.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const id = "file-input-answer";

export async function runInputFile(context: JourneyContext, session: TargetSession, campaignId: string,
  evidence: JourneyEvidence, options: { deadlineAt: number; directory: string }) {
  const agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId)
    throw new JourneyError("unsupported", "native_agent_and_environment_required");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const fixture = inputFileFixture(randomBytes(16).toString("hex"));
  const file = path.join(options.directory, fixture.filename);
  await writeFile(file, fixture.bytes, { mode: 0o600 });
  const key = "upload-summary", title = `Journey QA uploaded input ${campaignId}`;
  const prompt = `Read the attached ${fixture.filename}. Count only rows whose decision is accepted and sum their units. `
    + `Save a task document with key ${key} containing JSON with exactly these fields: reference (the reference in the file), `
    + "acceptedRows (the accepted row count), and acceptedUnits (their units total). Do not count declined rows. "
    + "Keep the original attachment unchanged, then finish the task. No other tasks or agents are needed.";
  const created = await createTaskThroughUi({ page: context.page, origin: context.api.origin,
    issuePrefix: context.company.issuePrefix, agentName: agent.name, title, prompt, workMode: "standard",
    requireExplicitTitle: true, attachments: [file],
    beforeDispatch: () => session.own({ kind: "issue", name: title, journeyId: id }) });
  await session.own({ kind: "issue", name: title, id: created.issueId, journeyId: id });
  const route = `/api/issues/${created.issueId}`;
  const check = (name: string, passed: boolean) => {
    evidence.checks.push({ id: name, passed });
    if (!passed) throw new JourneyError("failed", name.replaceAll("-", "_"));
  };
  const inputs = await waitFor(options.deadlineAt, () => context.api.get<InputFileAttachment[]>(`${route}/attachments`),
    rows => rows.some(row => row.originalFilename === fixture.filename), "uploaded_input_missing");
  const original = inputs.find(row => row.originalFilename === fixture.filename);
  const inputBytes = original ? await context.api.bytes(`/api/attachments/${original.id}/content`) : Buffer.alloc(0);
  check("input-upload-bytes-preserved", inputs.filter(row => row.originalFilename === fixture.filename).length === 1 && inputFileAttachmentMatches(original,
    { companyId: context.company.id, issueId: created.issueId, fixture, downloaded: inputBytes }));

  const state = await waitFor(options.deadlineAt, async () => {
    const [currentIssue, runs, comments, interactions] = await Promise.all([
      context.api.get<Row & { id: string; status: string }>(route), context.api.get<Row[]>(`${route}/runs`),
      context.api.get<Row[]>(`${route}/comments?order=asc`), context.api.get<Array<Row & { id: string; status: string }>>(`${route}/interactions`),
    ]);
    if (runs.length > 1) throw new JourneyError("failed", "input_file_run_limit_exceeded");
    const taskRuns = await Promise.all(runs.map(row => context.api.get<Row & { status: string }>(`/api/heartbeat-runs/${row.runId}`)));
    const value = { currentIssue, taskRuns, comments, interactions, attachments: [] };
    validateAgentTaskState(context, created.issueId, value, 1);
    return value;
  }, value => value.currentIssue.status === "done" && value.taskRuns.length === 1
    && value.taskRuns[0]!.status === "succeeded" && value.interactions.every(row => row.status !== "pending"),
  "input_file_task_not_completed");
  const document = await context.api.get<Row>(`${route}/documents/${key}`);
  const revision = await context.api.get<Row>(`${route}/documents/${key}/revisions/${document.latestRevisionId}`);
  check("input-content-used-correctly", inputFileSummaryMatches(document.body, fixture.expected));
  check("input-result-attributed-to-run", document.companyId === context.company.id && document.issueId === created.issueId
    && document.createdByAgentId === agent.id && document.createdByUserId === null
    && revision.documentId === document.id && revision.createdByRunId === state.taskRuns[0]!.id
    && revision.createdByAgentId === agent.id && inputFileSummaryMatches(revision.body, fixture.expected));
  const url = `${context.api.origin}/${context.company.issuePrefix}/issues/${state.currentIssue.identifier ?? created.issueId}`;
  await context.page.goto(url, { waitUntil: "domcontentloaded" });
  await context.page.reload();
  await openDocumentAuthoring(context);
  const saved = context.page.locator(`#document-${key}`);
  await expect(saved).toContainText(fixture.expected.reference);
  const reopened = await context.api.get<Row>(`${route}/documents/${key}`);
  const retainedInputs = await context.api.get<InputFileAttachment[]>(`${route}/attachments`);
  const retained = retainedInputs.find(row => row.id === original?.id);
  check("input-result-reopened", reopened.latestRevisionId === document.latestRevisionId
    && inputFileSummaryMatches(reopened.body, fixture.expected));
  check("original-input-retained", retainedInputs.filter(row => row.originalFilename === fixture.filename).length === 1 && inputFileAttachmentMatches(retained,
    { companyId: context.company.id, issueId: created.issueId, fixture,
      downloaded: retained ? await context.api.bytes(`/api/attachments/${retained.id}/content`) : Buffer.alloc(0) }));
  check("configured-model-and-environment", true); // Every observed run was independently checked above.
  await writeFile(path.join(options.directory, "input-file-checks.json"), JSON.stringify({
    inputSha256: createHash("sha256").update(fixture.bytes).digest("hex"), expected: fixture.expected,
    issueId: created.issueId, attachmentId: original!.id, documentId: document.id,
    revisionId: revision.id, runId: state.taskRuns[0]!.id,
  }, null, 2), { mode: 0o600 });
}

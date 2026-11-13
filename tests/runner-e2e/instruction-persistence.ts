import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { captureFirstTaskAttachments } from "./first-task-attachments.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution, RunnerTaskFixture } from "./types.js";

type Row = Record<string, any>;
export const instructionNonceLine = (nonce: string) => `Instruction persistence nonce: ${nonce}\n`;
export const instructionPersistenceTask: RunnerTaskFixture = {
  id: "private-copy-persists", label: "Agent directory survives a fresh task",
  groups: [], workMode: "standard", flow: "instruction_persistence",
  expectedRunCount: 6, attemptTimeoutMs: { local: 20 * 60_000, daytona: 20 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Persist private instructions ${nonce}`,
  buildVisibleMarker: () => "INSTRUCTIONS-VERIFIED",
  buildPrompt: nonce => [
    "Edit your own registered writable agent instruction entry with ordinary filesystem tools. The runtime guidance gives its exact private path.",
    "Use Node.js built-in fs for these byte-preserving edits. Apply each append exactly once: inspect the existing suffix before retrying any command, because a warning does not imply that its writes failed.",
    `Preserve its existing bytes and append exactly this UTF-8 suffix, represented as a JSON string: ${JSON.stringify(`\n${instructionNonceLine(nonce)}`)}`,
    "Decode the JSON string once and append those bytes. Do not trim or normalize the existing file and do not add another blank line or separator.",
    `In AGENT_HOME, create notes/retained.txt containing exactly ${JSON.stringify(`Personal file nonce: ${nonce}\n`)}. Create notes/bytes.bin with exactly the bytes [0,255,17,128,9]. Read notes/from-editor.txt and append exactly a newline followed by Edited by agent. and a final newline.`,
    "Do not use update_agent_instructions, restore_agent_instructions, or an instructions API to save it. Do not edit repository AGENTS.md or the read-only loaded bundle.",
    "After verifying the edits, upload a small text/plain attachment named agent-file-check.txt containing only 'Private file edits verified'. Use this attachment as your task completion evidence; the personal files themselves stay in AGENT_HOME.",
    "Reply only Instruction copy edited without printing filesystem paths, then complete this task after the file edit. Paperclip will collect it after the provider stops; do not claim it has already persisted. Do not create further tasks.",
  ].join("\n"),
  buildMatchers: () => [], // Independent current file and attachment oracle below.
};

export function gradeInstructionPersistence(input: { before: Row; after: Row; firstRunId: string; expectedContent: string; proof: Row | undefined; expectedProof: string; saveEvent?: Row; fileProof?: boolean }) {
  return [
    { id: "directory-save-receipt", passed: input.saveEvent?.runId === input.firstRunId && input.saveEvent?.state === "saved" },
    { id: "nested-and-binary-files", passed: input.fileProof === true },
    { id: "exact-canonical-bytes", passed: input.after.content === input.expectedContent && input.after.contentHash === createHash("sha256").update(input.expectedContent).digest("hex") },
    { id: "fresh-task-downloaded-proof", passed: input.proof?.contentVerified === true && input.proof.body === input.expectedProof },
  ].map(check => ({ ...check, detail: check.passed ? `${check.id} verified independently` : `${check.id} missing or incorrect` }));
}

export async function runInstructionPersistenceFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  secrets: readonly string[]; deadlineAt: number;
  restart(): Promise<void>;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, data: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  // Fixture names contain the campaign nonce. Use an unrelated value that the
  // fresh task can obtain only from the saved entry (or forbidden task history).
  const persistedNonce = randomBytes(16).toString("hex");
  const filePath = `/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=AGENTS.md`;
  const before = await api.get<Row>(filePath);
  if (typeof before.content !== "string" || !before.contentHash) throw new Error("Managed instructions must expose a current file hash");
  const expectedContent = `${before.content}\n${instructionNonceLine(persistedNonce)}`;
  const instructionsUrl = `/${fixtures.company.issuePrefix}/agents/${fixtures.agent.id}/instructions`;
  const editorText = `Editor nonce: ${randomBytes(16).toString("hex")}`;
  await page.goto(instructionsUrl);
  await page.getByRole("button", { name: "Add agent file", exact: true }).click();
  await page.getByPlaceholder("TOOLS.md").fill("notes/from-editor.txt");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("group", { name: "Instruction file view" }).getByRole("button", { name: "edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Instruction file editor" }).fill(editorText);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "History", exact: true })).toHaveCount(0);
  let issue: Row = {};
  let runs: Row[] = [];
  async function create(title: string, prompt: string) {
    const createdTask = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title, prompt, workMode: "standard", projectName: fixtures.project?.name });
    const found = await pollUntil({ label: `instruction task ${title}`, deadlineAt: input.deadlineAt,
      load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(row => row.id === createdTask.issueId), accept: row => Boolean(row) });
    if (!found) throw new Error("Browser-created instruction task missing");
    issue = found;
    input.observe(issue, runs);
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  }
  async function settle(count: number) {
    await pollUntil({ label: `instruction run ${count} completed`, deadlineAt: input.deadlineAt,
      load: async () => {
        issue = await api.get<Row>(`/api/issues/${issue.id}`);
        const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
        runs = await Promise.all(listed.map(row => api.get<Row>(`/api/heartbeat-runs/${row.id}`)));
        runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        input.observe(issue, runs);
        return { issue, runs };
      },
      accept: state => state.issue.status === "done" && state.runs.length === count && state.runs.every(row => row.status === "succeeded"),
      reject: state => state.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Instruction task provider run failed" : state.runs.length > count ? "Instruction task dispatched an extra run" : state.issue.status === "blocked" && state.runs.length === count && state.runs.every(row => row.status === "succeeded") ? `Instruction task reported a terminal blocker: ${JSON.stringify(state.issue.unblockDescriptor ?? {})}` : undefined,
    });
    expect(runs.every(row => row.runtimeMode === execution.profile.expectedRuntimeMode)).toBe(true);
    await page.reload();
    await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
  }
  await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(persistedNonce));
  await settle(1);
  const firstRunId = runs[0]!.id;
  const after = await pollUntil({ label: "stopped agent directory save", deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
    load: () => api.get<Row>(filePath), accept: row => row.content === expectedContent });
  const events = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${firstRunId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const saveEvent = events.find(row => row.eventType === "instruction_save" && row.payload?.state === "saved");
  expect(saveEvent).toBeTruthy();
  const readPersonal = (name: string) => api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(name)}`);
  const note = await readPersonal("notes/retained.txt");
  const fromEditor = await readPersonal("notes/from-editor.txt");
  const binaryResponse = await api.request.get(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=notes%2Fbytes.bin&download=true`);
  expect(binaryResponse.ok()).toBe(true);
  const binary = await binaryResponse.body();
  const fileProof = note.content === `Personal file nonce: ${persistedNonce}\n` && fromEditor.content === `${editorText}\nEdited by agent.\n` && binary.equals(Buffer.from([0,255,17,128,9]));
  expect(fileProof).toBe(true);
  const history = await api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle/history?path=AGENTS.md`);
  expect(history.revisions).toHaveLength(0);
  await input.evidence("instruction-first-save.json", { before, after, run: runs[0], events });
  await input.capture("instruction-edited", "Private instructions saved after provider stop", "instruction-edited.png");
  // A new server and a new issue cannot pass by retaining model conversation.
  await input.restart();
  expect((await api.get<Row>(filePath)).content).toBe(expectedContent);
  await create("Read persisted instructions", [
    "Read your own loaded agent instruction entry (or its current registered private copy) using ordinary filesystem tools.",
    "Find the line beginning 'Instruction persistence nonce: '. Copy that entire line plus one final newline into instruction-proof.txt. Then append the exact bytes of notes/retained.txt from AGENT_HOME. Verify notes/bytes.bin contains the bytes [0,255,17,128,9]. Do not infer the value from this task title or other task history. Do not change your instructions.",
    "Upload instruction-proof.txt as a text/plain task attachment named instruction-proof.txt using the normal artifact workflow. A local file alone is insufficient.",
    `Reply with exactly ${execution.task.buildVisibleMarker(nonce)} and complete the task.`,
  ].join("\n"));
  await settle(2);
  const attachments = await captureFirstTaskAttachments(api, [{ ...issue, id: String(issue.id) }], input.secrets);
  const proof = attachments.find(row => row.originalFilename === "instruction-proof.txt" || row.name === "instruction-proof.txt");
  const final = await api.get<Row>(filePath);
  expect(final.revision.id).toBe(after.revision.id);
  const checks = gradeInstructionPersistence({ before, after, firstRunId, expectedContent, proof, expectedProof: `${instructionNonceLine(persistedNonce)}Personal file nonce: ${persistedNonce}\n`, saveEvent: { runId: firstRunId, state: saveEvent?.payload?.state }, fileProof });
  await expect(page.getByTestId("task-chat-agent-bubble").filter({ hasText: execution.task.buildVisibleMarker(nonce) }).last()).toBeVisible();
  await input.capture("final-state", "Fresh task downloaded the persisted instruction nonce", "final-state.png");
  expect(checks.filter(check => !check.passed), "Independent instruction persistence checks").toEqual([]);

  checks.push({ id: "editor-round-trip-no-history", passed: true, detail: "A browser-created supporting file was edited by the agent; all current bytes persisted without revision rows" });
  const restored = final;

  // The provider publishes an ordinary attachment before a bounded command wait.
  // A board edit during that run is superseded only for the same changed file.
  const conflictSuffix = `\nLast completed synchronization: ${nonce}\n`;
  const expectedCandidate = `${restored.content}${conflictSuffix}`;
  await create("Sync a concurrent instruction edit", [
    "Use Node.js built-in fs. Apply the append exactly once, checking existing bytes before any retry.",
    `Append exactly this UTF-8 suffix to your current registered writable instruction entry, represented as a JSON string: ${JSON.stringify(conflictSuffix)}`,
    "Decode the JSON string once. Preserve all existing bytes. Do not use an instruction revision tool or instructions API.",
    "After the file edit, upload a text/plain task attachment named instruction-candidate-ready.txt with the text ready. Use the ordinary artifact workflow.",
    "Then execute the ordinary shell command sleep 45 and wait for it to finish. This gives the board time to edit the canonical instructions concurrently. Do not complete the task before that command finishes.",
    "After the wait completes, reply Candidate edit ready and complete the task. Do not change the instructions again or claim that they saved.",
  ].join("\n"));
  await pollUntil({ label: "provider staged concurrent instruction edit", deadlineAt: input.deadlineAt,
    load: () => api.get<Row[]>(`/api/issues/${issue.id}/attachments`),
    accept: rows => rows.some(row => row.originalFilename === "instruction-candidate-ready.txt" || row.name === "instruction-candidate-ready.txt") });
  const active = await api.get<Row[]>(`/api/issues/${issue.id}/runs`);
  expect(active.some(row => row.status === "running")).toBe(true);
  const boardMarker = "Concurrent board instruction edit.";
  await page.goto(instructionsUrl);
  await page.getByText("AGENTS.md", { exact: true }).first().click();
  await page.getByRole("group", { name: "Instruction file view" }).getByRole("button", { name: "edit", exact: true }).click();
  const entryEditor = page.getByRole("textbox", { name: "editable markdown" });
  await entryEditor.click();
  await entryEditor.press("ControlOrMeta+End");
  await entryEditor.press("Enter");
  await entryEditor.pressSequentially(boardMarker);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  const board = await api.get<Row>(filePath);
  expect(board.content).toContain(boardMarker);
  expect(board.contentHash).not.toBe(restored.contentHash);
  const unrelatedContent = `Concurrent independent file: ${nonce}`;
  const unrelated = await api.request.put(`/api/agents/${fixtures.agent.id}/instructions-bundle/file`, {
    data: { path: "notes/concurrent-editor.txt", content: unrelatedContent, baseHash: null },
  });
  expect(unrelated.ok()).toBe(true);
  await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await settle(3);
  const syncRunId = runs[2]!.id;
  const resolved = await pollUntil({ label: "last completed sync wins", deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
    load: () => api.get<Row>(filePath), accept: row => row.content === expectedCandidate });
  const candidates = await api.get<Row[]>(`/api/agents/${fixtures.agent.id}/instructions-bundle/candidates`);
  expect(candidates.some(row => row.runId === syncRunId)).toBe(false);
  expect((await readPersonal("notes/concurrent-editor.txt")).content).toBe(unrelatedContent);
  const syncEvents = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${syncRunId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  expect(syncEvents.some(row => row.eventType === "instruction_save" && row.payload?.state === "saved")).toBe(true);
  await page.goto(instructionsUrl);
  await expect(page.getByRole("button", { name: "Review preserved files", exact: true })).toHaveCount(0);
  checks.push({ id: "per-file-last-sync-wins", passed: true, detail: "The later agent sync replaced the concurrent browser edit to its changed entry, preserved an unrelated new file, and created no conflict candidate" });
  await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await input.capture("last-sync-wins", "Concurrent changes synchronized per file without a conflict-review step", "last-sync-wins.png");

  const quotaTask = (action: string, receipt: string) => [
    "This is a controlled persistent-storage quota check. Use ordinary Node.js filesystem tools in your registered AGENT_HOME. Do not edit AGENTS.md.",
    action,
    `Upload a small text/plain task attachment named ${receipt}.txt containing the observed file size or cleanup result. This attachment is the primary task deliverable.`,
    "Complete this task normally after uploading the receipt. A persistent-file storage warning is expected and must not prevent completion. Do not perform additional cleanup or change other personal files.",
  ].join("\n");
  await create("Reach the agent file storage limit", quotaTask(
    "Create quota-cache.bin using fs.openSync with flag w, fs.ftruncateSync(fd, 268435456), and fs.closeSync. This is a sparse fixture file, not a download. Verify its size using fs.statSync without reading the large contents.", "quota-full"));
  await settle(4);
  const fullRun = runs[3]!;
  expect(fullRun.resultJson?.instructionSave).toMatchObject({ state: "saved", storageWarning: expect.stringContaining("Agent storage is full") });
  await page.goto(`/${fixtures.company.issuePrefix}/agents/${fixtures.agent.id}/runs/${fullRun.id}`);
  await expect(page.getByRole("note").filter({ hasText: "Agent storage warning" })).toContainText("Runs can continue");
  // Public campaign screenshots are limited to sanitized task routes. Verify
  // the warning in the real run UI, then capture its completed task outcome.
  await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await input.capture("storage-warning", "Task succeeded while agent storage reached its limit", "storage-warning.png");

  await create("Keep running while agent storage is full", quotaTask(
    "Verify quota-cache.bin already exists and its size is exactly 268435456. Grow only this file to 268435457 bytes with fs.truncateSync, then verify the new size. Leave it above the limit for this run's sync check.", "quota-exceeded"));
  await settle(5);
  const exceededRun = runs[4]!;
  expect(exceededRun.resultJson?.instructionSave).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", storageWarning: expect.stringContaining("Runs can continue") });
  const fullEvents = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${exceededRun.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
  expect(fullEvents.some(row => row.eventType === "instruction_save" && row.level === "warn" && row.payload?.state === "prepared" && row.payload?.storageWarning)).toBe(true);

  await create("Clean up agent storage during a normal task", quotaTask(
    "Verify restored quota-cache.bin has size 268435456: the rejected oversized edit must not have replaced its saved bytes. Delete quota-cache.bin with fs.unlinkSync, then write notes/after-quota.txt containing exactly 'Runs still work after quota cleanup'.", "quota-cleaned"));
  await settle(6);
  const cleanedRun = runs[5]!;
  expect(cleanedRun.resultJson?.instructionSave).toMatchObject({ state: "saved", storageWarning: null });
  expect((await readPersonal("notes/after-quota.txt")).content).toBe("Runs still work after quota cleanup");
  const bundle = await api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle`);
  expect(bundle.files.some((file: Row) => file.path === "quota-cache.bin")).toBe(false);
  await page.goto(`/${fixtures.company.issuePrefix}/agents/${fixtures.agent.id}/runs/${cleanedRun.id}`);
  await expect(page.getByRole("note").filter({ hasText: "Agent storage warning" })).toHaveCount(0);
  checks.push({ id: "storage-full-does-not-block-runs", passed: true, detail: "A run saved a file at quota, a subsequent run succeeded despite an oversized save rejection, and the next run removed the full file and cleared its warning; all three tasks completed" });
  await input.evidence("api-state.json", { issue, runs, checks, canonicalInstructions: resolved, attachments });
  await input.evidence("instruction-persistence.json", { checks, before, after, final, restored, board, candidates, resolved, syncEvents, runs, attachments, fullEvents });
  await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await input.capture("storage-recovered", "Agent completed a normal task and cleared storage warning after cleanup", "storage-recovered.png");
  return { issue, runs, checks };
}

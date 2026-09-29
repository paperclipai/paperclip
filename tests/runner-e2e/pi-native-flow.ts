import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { gradePiNativeAnswers, hasFailedPiWrite, hasPiCrossRootDenial, PI_NATIVE_MEMORY_PATH, piNativeFinish } from "./pi-native-cases.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };

export async function runPiNativeFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  workspacePath: string; deadlineAt: number; restart(): Promise<void>;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, data: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  if (execution.environment.id !== "local" || execution.profile.qualificationCandidate !== "pi") throw new Error("Pi native fixtures require the isolated local Pi candidate");
  const checks: Check[] = []; let issue: Row = {}; let runs: Row[] = [];
  const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, {
    name: `Pi native workspace ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } },
    workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true },
  });
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  const events = (runId: string) => collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const absent = async (path: string) => { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
  const load = async () => {
    issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); input.observe(issue, runs);
    const interactions = await api.get<Row[]>(`/api/issues/${issue.id}/interactions`);
    return { issue, runs, interactions };
  };
  const rejectFailure = (state: Awaited<ReturnType<typeof load>>) => state.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Pi provider run failed" : undefined;
  async function create(title: string, prompt: string) {
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title, prompt, workMode: "standard", projectName: project.name });
    const found = await pollUntil({ label: title, deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(row => row.title === title), accept: Boolean });
    if (!found) throw new Error("Browser-created Pi task is absent"); issue = found; input.observe(issue, runs);
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  }
  async function settle(count: number) {
    const result = await pollUntil({ label: "Pi native task completion", deadlineAt: input.deadlineAt, load,
      accept: state => state.issue.status === "done" && state.runs.length === count && state.runs.every(run => run.status === "succeeded") && !state.interactions.some(row => row.status === "pending"),
      reject: state => rejectFailure(state) ?? (state.runs.length > count ? "Extra Pi provider run" : undefined) });
    check(`native-runs-${count}`, result.runs.every(run => run.runtimeMode === "native"), "Every accounted run used the native runtime");
    await page.reload(); await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
    return result;
  }
  try {
    if (execution.task.id === "native-questions") {
      const name = `name-${randomBytes(8).toString("hex")}`; const draft = `draft-${randomBytes(8).toString("hex")}\nSecond line`;
      await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(nonce));
      const seen = new Set<string>(); let runId: string | undefined;
      const forms = [{ title: "Pi native color", label: "Blue" }, { title: "Pi native confirmation", label: "No" }, { title: "Pi native name", value: name }, { title: "Pi native draft", value: draft }];
      for (const [index, form] of forms.entries()) {
        const state = await pollUntil({ label: form.title, deadlineAt: input.deadlineAt, load, reject: rejectFailure,
          accept: state => state.interactions.some(row => row.kind === "ask_user_questions" && row.status === "pending" && row.payload?.runtimeRequestId && row.payload?.questionSet?.questions?.[0]?.header === form.title) });
        const pending = state.interactions.filter(row => row.status === "pending");
        check(`single-pending-${index}`, pending.length === 1 && state.runs.length === 1, "One durable native question belongs to one live provider run");
        const card = pending[0]!; runId ??= card.sourceRunId;
        check(`native-binding-${index}`, card.sourceRunId === runId && card.continuationPolicy === "none" && !seen.has(card.id), "Question retains its source run and distinct durable identity"); seen.add(card.id);
        await input.evidence(`pi-native-question-${index}-pending.json`, { issue, runs, interaction: card });
        await page.reload(); // Reconnect the browser while preserving the live native promise.
        const afterReload = (await load()).interactions.find(row => row.id === card.id);
        check(`reconnect-${index}`, afterReload?.status === "pending" && afterReload.payload.runtimeRequestId === card.payload.runtimeRequestId, "Reload preserved the same pending runtime request");
        await input.capture(`pi-question-${index}`, form.title, `pi-question-${index}.png`);
        if (form.label) await page.getByRole("radio", { name: form.label, exact: true }).last().click();
        else await page.getByTestId("question-text-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill(form.value!);
        await page.getByRole("button", { name: card.payload?.questionSet?.submitLabel ?? "Submit answers", exact: true }).last().click();
        const resolved = await pollUntil({ label: "durable native answer", deadlineAt: input.deadlineAt, load, reject: rejectFailure, accept: state => state.interactions.some(row => row.id === card.id && row.status === "answered") });
        await input.evidence(`pi-native-question-${index}-answered.json`, resolved.interactions.find(row => row.id === card.id));
      }
      const final = await settle(1);
      const proof = JSON.parse(await readFile(join(input.workspacePath, "pi-native-answers.json"), "utf8"));
      check("native-typed-delivery", gradePiNativeAnswers(proof, name, draft), "Independent workspace JSON contains the exact four typed native tool results, including undisclosed browser text");
      check("four-durable-answers", final.interactions.length === 4 && final.interactions.every(row => row.status === "answered" && row.sourceRunId === runId), "All four saved questions were answered in the original provider run");
      await input.evidence("pi-native-typed-proof.json", { proof, interactions: final.interactions, events: await events(runs[0]!.id) });
    } else if (execution.task.id === "agent-files-fresh-run") {
      const retained = randomBytes(16).toString("hex"); const outside = resolve(input.workspacePath, "..", `pi-unassigned-${nonce}.txt`);
      check("unassigned-initially-absent", await absent(outside), "The isolated cross-root marker did not already exist");
      await create(execution.task.buildTitle(nonce), `${execution.task.buildPrompt(retained)}\nBefore finishing, attempt native write exactly once to ${JSON.stringify(outside)} with content forbidden. This intentionally unassigned root must be denied. Never use bash or another operation to work around its failure.`);
      await settle(1);
      const personal = await api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(PI_NATIVE_MEMORY_PATH)}`);
      const firstEvents = await events(runs[0]!.id);
      check("registered-file-saved", personal.content === `${retained}\n`, "Public managed-file API contains the exact native-write bytes");
      check("stopped-save-receipt", firstEvents.some(row => row.eventType === "instruction_save" && row.payload?.state === "saved"), "Provider stop produced a durable file-save receipt");
      check("cross-root-denied", await absent(outside) && hasPiCrossRootDenial(firstEvents), "A single native write recorded the exact cross-root denial reason and the isolated target remains absent");
      await input.evidence("pi-agent-files-first-save.json", { personal, run: runs[0], events: firstEvents });
      await input.restart();
      await create(`Pi read persisted memory ${nonce}`, [
        `Use native read to read ${PI_NATIVE_MEMORY_PATH} under the fresh registered AGENT_HOME. Read its exact current bytes; do not infer them from another task, conversation, or history.`,
        "Use native write to copy those exact bytes into pi-agent-memory-proof.txt in the task workspace. This is an internal assertion file, not a deliverable. Do not change personal memory.",
        piNativeFinish(execution.task.buildVisibleMarker(nonce)),
      ].join("\n"));
      await settle(2);
      check("fresh-run-readback", await readFile(join(input.workspacePath, "pi-agent-memory-proof.txt"), "utf8") === `${retained}\n`, "A new issue after server restart copied the undisclosed saved agent-file bytes");
      const current = await api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(PI_NATIVE_MEMORY_PATH)}`);
      check("persistent-bytes-unchanged", current.content === personal.content, "Fresh-run readback preserved the saved managed bytes");
      await input.evidence("pi-agent-files-fresh-read.json", { current, runs, events: await events(runs[1]!.id) });
    } else if (execution.task.id === "restrictive-denial") {
      const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
      await api.patch(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "deny-all" } });
      const deniedPath = join(input.workspacePath, "pi-denied.txt");
      check("denied-file-initially-absent", await absent(deniedPath), "The isolated denied file did not already exist");
      await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(nonce));
      await settle(1); const runEvents = await events(runs[0]!.id);
      check("restrictive-native-denial", await absent(deniedPath) && hasFailedPiWrite(runEvents, "pi-denied.txt"), "A correlated failed native edit and independent absent file prove restrictive denial");
      await input.evidence("pi-restrictive-denial.json", { permissionMode: "deny-all", fileAbsent: true, run: runs[0], events: runEvents });
    } else throw new Error(`Unknown Pi native flow ${execution.task.id}`);
    await input.capture("final-state", "Pi native fixture verified", "final-state.png");
    return { issue, runs, checks };
  } finally { await input.evidence("pi-native-checks.json", { issue, runs, checks }); }
}

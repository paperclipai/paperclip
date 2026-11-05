import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { createTaskThroughUi } from "../user-actions.js";
import { waitFor } from "./agent-flows.js";
import { createObservedReader } from "./observation-read.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { AGENT_SETTINGS_CHECKS, gradeAgentSettings, instructionDigest, matchedBoardSaveAudit, settingsInstructionContent,
  settingsDocumentKey, settingsProofHeading, settingsTaskPrompt, type AgentSettingsEvidence, type AgentSettingsScope,
  type SettingsSnapshot } from "./agent-settings-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const id = "agent-settings-persistence";

export async function runAgentSettings(context: JourneyContext, session: TargetSession, campaignId: string,
  evidence: JourneyEvidence, options: { deadlineAt: number; directory: string }) {
  const agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId || !context.capabilities.includes("agent-settings-write")) {
    throw new JourneyError("unsupported", "owned_agent_settings_capability_required");
  }
  const scope: AgentSettingsScope = { campaignId, companyId: context.company.id, userId: context.user.id,
    agentId: agent.id, agentName: agent.name, provider: agent.provider, model: agent.model,
    environmentId: context.environmentId, reference: randomBytes(16).toString("hex") };
  const observations: AgentSettingsEvidence = {};
  const read = createObservedReader(context.api, options.deadlineAt), agentRoute = `/api/agents/${agent.id}`;
  const agentRunsRoute = `/api/companies/${scope.companyId}/heartbeat-runs?agentId=${agent.id}&limit=100`;
  const activityRoute = `/api/companies/${scope.companyId}/activity?entityType=agent&entityId=${agent.id}&limit=200`;
  const snapshot = async (): Promise<SettingsSnapshot> => {
    const [current, bundle, runs, activity] = await Promise.all([
      read.get<Row>(agentRoute), read.get<Row>(`${agentRoute}/instructions-bundle`),
      read.get<Row[]>(agentRunsRoute), read.get<Row[]>(activityRoute),
    ]);
    if (typeof bundle?.entryFile !== "string" || !bundle.entryFile || !Array.isArray(runs) || runs.length >= 100
      || !Array.isArray(activity) || activity.length >= 200
      || activity.some(row => row.companyId !== scope.companyId || row.entityType !== "agent" || row.entityId !== agent.id)) {
      throw new JourneyError("failed", "agent_settings_read_coverage_unavailable");
    }
    const file = await read.get<Row>(`${agentRoute}/instructions-bundle/file?path=${encodeURIComponent(bundle.entryFile)}`);
    return { agent: current, bundle, file, runs, activity };
  };
  const openInstructions = async (entry: string, expectedContent: string, reload = false) => {
    await context.page.goto(`${context.api.origin}/${context.company.issuePrefix}/agents/${agent.id}/instructions`, { waitUntil: "domcontentloaded" });
    if (reload) await context.page.reload();
    const segments = entry.split("/");
    const treeRow = (filePath: string) => context.page.locator(`[role="treeitem"][data-file-tree-path=${JSON.stringify(filePath)}]`);
    for (let depth = 1; depth < segments.length; depth++) {
      const directory = treeRow(segments.slice(0, depth).join("/"));
      await expect(directory).toBeVisible();
      if (await directory.getAttribute("aria-expanded") !== "true") await directory.click();
    }
    const entryRow = treeRow(entry);
    await expect(entryRow).toBeVisible();
    await entryRow.click();
    const edit = context.page.getByRole("button", { name: `Edit ${entry}`, exact: true });
    await expect(edit).toBeVisible();
    if (!expectedContent.trim()) {
      await edit.click();
      const editor = context.page.getByRole("textbox", { name: "Instruction file editor", exact: true });
      await expect(editor).toHaveValue(expectedContent);
      const renderedContent = await editor.inputValue();
      await context.page.getByRole("button", { name: `Stop editing ${entry}`, exact: true }).click();
      return { edit, renderedContent };
    }
    const raw = context.page.getByTestId("instructions-raw-source");
    await expect(raw).toBeVisible();
    const renderedContent = await raw.textContent();
    if (renderedContent !== expectedContent) throw new JourneyError("failed", "agent_settings_rendered_source_mismatch");
    return { edit, renderedContent };
  };
  const saveThroughUi = async (beforePoint: SettingsSnapshot, content: string) => {
    const entry = beforePoint.bundle.entryFile, before = beforePoint.file.content;
    const { edit } = await openInstructions(entry, before);
    await edit.click();
    const editor = context.page.getByRole("textbox", { name: "Instruction file editor", exact: true });
    await expect(editor).toHaveValue(before);
    await editor.fill(content);
    const save = context.page.getByRole("button", { name: "Save changes", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 30_000 });
    // Disabled can also mean saving. Confirm persisted bytes and the new audit
    // before navigating, including during restoration.
    return waitFor(options.deadlineAt, snapshot, point => point.file.content === content
      && Boolean(matchedBoardSaveAudit(point, beforePoint, scope)), "agent_settings_save_not_persisted");
  };
  const check = (name: typeof AGENT_SETTINGS_CHECKS[number]) => {
    const result = gradeAgentSettings(scope, observations).find(row => row.id === name)!;
    evidence.checks.push(result);
    if (!result.passed) throw new JourneyError("failed", name.replaceAll("-", "_"));
  };
  let failed = false;
  try {
    observations.original = await snapshot();
    const original = observations.original, entry = original.bundle.entryFile;
    if (original.agent.id !== agent.id || original.agent.companyId !== scope.companyId || original.agent.name !== agent.name
      || !agent.name.includes(campaignId) || original.agent.adapterType !== "paperclip_runner"
      || original.agent.adapterConfig?.provider !== agent.provider || original.agent.adapterConfig?.model !== agent.model
      || original.bundle.mode !== "managed" || original.bundle.editable !== true || original.file.editable !== true
      || typeof original.file.content !== "string" || original.file.content.includes("\r")
      || original.file.content.includes(settingsProofHeading) || original.runs.length !== 0) {
      throw new JourneyError("failed", "agent_settings_fixture_not_fresh_owned");
    }
    const edited = settingsInstructionContent(original.file.content, scope.reference);
    observations.saved = await saveThroughUi(original, edited);
    check("agent-settings-browser-save");
    const reopenedSource = await openInstructions(entry, edited, true);
    observations.reloaded = { ...await snapshot(), renderedContent: reopenedSource.renderedContent };
    check("agent-settings-reload-persisted");

    const title = `Journey QA agent settings ${campaignId}`;
    const task = await createTaskThroughUi({ page: context.page, origin: context.api.origin, issuePrefix: context.company.issuePrefix,
      agentName: agent.name, title, prompt: settingsTaskPrompt, workMode: "standard", requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: title, journeyId: id }) });
    await session.own({ kind: "issue", name: title, id: task.issueId, journeyId: id });
    const route = `/api/issues/${task.issueId}`, documentRoute = `${route}/documents/${settingsDocumentKey}`;
    const state = await waitFor(options.deadlineAt, async () => {
      const [issue, summaries, interactions] = await Promise.all([
        read.get<Row>(route), read.get<Row[]>(`${route}/runs`), read.get<Row[]>(`${route}/interactions`),
      ]);
      if (!Array.isArray(summaries) || summaries.length > 1 || !Array.isArray(interactions)) throw new JourneyError("failed", "agent_settings_run_coverage_mismatch");
      const runs = await Promise.all(summaries.map(row => read.get<Row>(`/api/heartbeat-runs/${row.runId}`)));
      if (runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status))) throw new JourneyError("failed", "agent_settings_native_run_failed");
      return { issue, runs, interactions };
    }, point => point.issue.status === "done" && point.runs.length === 1 && point.runs[0]!.status === "succeeded"
      && point.runs[0]!.nativePhase === "committed" && point.interactions.every(row => row.status !== "pending"), "agent_settings_task_not_completed");
    const document = await read.get<Row>(documentRoute);
    const revision = await read.get<Row>(`${documentRoute}/revisions/${document.latestRevisionId}`);
    observations.task = { ...state, document, revision };
    observations.afterWork = await snapshot();
    check("agent-settings-instruction-only-input");
    check("configured-model-and-environment");
    check("agent-settings-result-attributed");
    await context.page.goto(`${context.api.origin}/${context.company.issuePrefix}/issues/${state.issue.identifier ?? task.issueId}`, { waitUntil: "domcontentloaded" });
    await context.page.reload();
    await openDocumentAuthoring(context);
    const displayed = context.page.locator(`#document-${settingsDocumentKey}`);
    await expect(displayed).toContainText(scope.reference);
    observations.task.reopenedDocument = await read.get<Row>(documentRoute);
    observations.task.reopenedRevision = await read.get<Row>(`${documentRoute}/revisions/${document.latestRevisionId}`);
    observations.task.renderedReference = (await displayed.textContent())?.includes(scope.reference) ? scope.reference : undefined;
    check("agent-settings-result-reopened");

    await saveThroughUi(observations.afterWork, original.file.content);
    const restoredSource = await openInstructions(entry, original.file.content);
    observations.restored = { ...await snapshot(), renderedContent: restoredSource.renderedContent };
    check("agent-settings-original-restored");
    // The shared screenshot policy permits only the task result, not settings.
    await context.page.goto(`${context.api.origin}/${context.company.issuePrefix}/issues/${state.issue.identifier ?? task.issueId}`, { waitUntil: "domcontentloaded" });
    await openDocumentAuthoring(context);
    await expect(context.page.locator(`#document-${settingsDocumentKey}`)).toContainText(scope.reference);
  } catch (error) { failed = true; throw error; }
  finally {
    try {
      await read.preserve(options.directory);
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(options.directory, "agent-settings-observations.json"), JSON.stringify({
        companyId: scope.companyId, agentId: scope.agentId, reference: scope.reference,
        checkpoints: Object.fromEntries(["original", "saved", "reloaded", "afterWork", "restored"].map(key => {
          const point = observations[key as Exclude<keyof AgentSettingsEvidence, "task">];
          return [key, point ? { entryFile: point.file.path, contentHash: point.file.contentHash,
            independentlyComputedHash: typeof point.file.content === "string" ? instructionDigest(point.file.content) : null,
            revisionId: point.file.revision?.id ?? null, runIds: point.runs.map(row => row.id ?? row.runId) } : null];
        })),
        issueId: observations.task?.issue.id ?? null, runIds: observations.task?.runs.map(row => row.id) ?? [],
        documentId: observations.task?.document.id ?? null, documentRevisionId: observations.task?.revision.id ?? null,
        saveAudits: { saved: matchedBoardSaveAudit(observations.saved, observations.original, scope),
          restored: matchedBoardSaveAudit(observations.restored, observations.afterWork, scope) },
        checks: gradeAgentSettings(scope, observations),
      }, null, 2), { mode: 0o600 });
    } catch (error) { if (!failed) throw error; }
  }
}

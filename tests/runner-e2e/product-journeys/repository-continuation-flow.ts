import { createObservedReader } from "./observation-read.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { WorkspaceFileContent } from "../../../packages/shared/src/types/workspace-file-resource.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { createTaskThroughUi, submitTaskReply } from "../user-actions.js";
import { fixtureReplyStoredOnce, validateAgentTaskState, waitFor } from "./agent-flows.js";
import { repositoryContinuationSource, repositoryContinuationStory } from "./repository-continuation-contract.js";
import { inspectRepositoryBundle, repositoryCommitMatches, repositoryWorkspaceBindingMatches, repositoryWorkspaceFileMatches } from "./repository-continuation-evidence.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const id = "repository-continuation";

/** Attached and managed targets share the browser story and byte/Git oracle. */
export async function runRepositoryContinuation(context: JourneyContext, session: TargetSession, campaignId: string,
  evidence: JourneyEvidence, options: { deadlineAt: number; directory: string }) {
  const { api, page, company, agent } = context;
  const observations = createObservedReader(api, options.deadlineAt);
  const readObserved = observations.get;
  try {
    if (!agent || agent.runtimeMode !== "native" || !context.environmentId)
      throw new JourneyError("unsupported", "native_agent_and_environment_required");
    const story = repositoryContinuationStory(campaignId), { files } = story, source = repositoryContinuationSource;
    await mkdir(options.directory, { mode: 0o700, recursive: true });
    const retain = (filename: string, value: unknown) => writeFile(path.join(options.directory, filename), JSON.stringify(value, null, 2), { mode: 0o600 });
    const check = (name: string, passed: boolean) => {
      evidence.checks.push({ id: name, passed });
      if (!passed) throw new JourneyError("failed", name.replaceAll("-", "_"));
    };
    const projectName = `Journey QA repository ${campaignId}`;
    await session.own({ kind: "project", name: projectName, journeyId: id });
    const project = await api.post<Row>(`/api/companies/${company.id}/projects`, {
      name: projectName, description: "Disposable read-only public repository continuation fixture.",
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize",
        allowIssueOverride: false, environmentId: context.environmentId, workspaceStrategy: { type: "project_primary" } },
      workspace: { name: "Primary", sourceType: "git_repo", repoUrl: source.url, repoRef: source.commit, isPrimary: true },
    });
    await session.own({ kind: "project", name: projectName, id: project.id, journeyId: id });
    const configured = await readObserved<Row>(`/api/projects/${project.id}`);
    const projectWorkspaces = configured.workspaces?.filter((workspace: Row) => workspace.repoUrl === source.url && workspace.repoRef === source.commit && workspace.isPrimary);
    if (configured.companyId !== company.id || !Array.isArray(projectWorkspaces) || projectWorkspaces.length !== 1)
      throw new JourneyError("failed", "repository_project_source_mismatch");
    const projectWorkspaceId = projectWorkspaces[0]!.id;
    const title = `Journey QA repository continuation ${campaignId}`;
    const created = await createTaskThroughUi({ page, origin: api.origin, issuePrefix: company.issuePrefix,
      agentName: agent.name, projectName, title, prompt: story.first, workMode: "standard", requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: title, journeyId: id }) });
    await session.own({ kind: "issue", name: title, id: created.issueId, journeyId: id });
    const route = `/api/issues/${created.issueId}`;
    const read = async () => {
      const [currentIssue, summaries, comments, interactions] = await Promise.all([
        readObserved<Row & { id: string; status: string }>(route), readObserved<Row[]>(`${route}/runs`),
        readObserved<Row[]>(`${route}/comments?order=asc`), readObserved<Array<Row & { id: string; status: string }>>(`${route}/interactions`),
      ]);
      if (!Array.isArray(summaries) || summaries.length > 2) throw new JourneyError("failed", "repository_run_limit_exceeded");
      const taskRuns = (await Promise.all(summaries.map(summary => readObserved<Row & { status: string }>(`/api/heartbeat-runs/${summary.runId}`))))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
      const state = { currentIssue, taskRuns, comments, interactions, attachments: [] };
      await retain("repository-latest-task.json", state);
      validateAgentTaskState(context, created.issueId, state, 2);
      if (currentIssue.projectId !== project.id) throw new JourneyError("failed", "repository_project_binding_mismatch");
      return state;
    };
    const settled = (count: number) => waitFor(options.deadlineAt, read, state => state.currentIssue.status === "done"
      && state.taskRuns.length === count && state.taskRuns.every(run => run.status === "succeeded"
        && run.nativePhase === "committed" && run.resultJson?.finalizationPhase === "committed")
      && state.interactions.every(row => row.status !== "pending"), "repository_task_not_completed");
    // Use the attached target's origin for the common registration/download oracle.
    const artifactApi = { get: <T>(route: string) => readObserved<T>(route), request: { get: (route: string) => api.response(route) } };
    const bundle = async (name: string, runId: string) => {
      const [artifact] = await readRegisteredArtifacts(artifactApi, created.issueId, runId, [name]);
      const bytes = await api.bytes(`/api/attachments/${artifact!.attachmentId}/content?download=1`);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact!.sha256) throw new JourneyError("failed", "repository_bundle_download_changed");
      await writeFile(path.join(options.directory, name), bytes, { mode: 0o600, flag: "wx" });
      return { artifact: artifact!, bytes };
    };
    // Task-chat layouts keep generic output controls in Artifacts. Use the
    // production download link for this exact attachment, not a coincidental
    // URL in a model reply or an API-only readback.
    const browserDownload = async (artifact: { attachmentId: string; sha256: string }, phase: string) => {
      await openDocumentAuthoring(context);
      const link = page.getByRole("link", { name: /^Download/ }).and(
        page.locator(`a[href*="/api/attachments/${artifact.attachmentId}/content"]`)).first();
      await expect(link).toBeVisible();
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: Math.max(1, Math.min(30_000, options.deadlineAt - Date.now())) }), link.click()]);
      const filename = path.join(options.directory, `browser-${phase}`);
      await download.saveAs(filename);
      const bytes = await readFile(filename);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new JourneyError("failed", "repository_browser_download_changed");
    };
    const file = (name: string) => readObserved<WorkspaceFileContent>(`${route}/file-resources/content?workspace=execution&path=${encodeURIComponent(name)}`);
    const first = await settled(1), firstRun = first.taskRuns[0]!;
    const initialView = await readObserved<Row>(`${route}/workspace`), workspaceId = initialView.workspace?.id;
    const binding = (issue: Row, view: Row, runs: Row[]) => repositoryWorkspaceBindingMatches({ companyId: company.id,
      issueId: created.issueId, projectId: project.id, projectWorkspaceId, workspaceId, repoUrl: source.url, issue, view, runs });
    check("repository-configured-source-bound", binding(first.currentIssue, initialView, first.taskRuns));
    const [referenceArtifact] = await readRegisteredArtifacts(artifactApi, created.issueId, firstRun.id, [files.context]);
    const original = referenceArtifact!.content;
    if (!/^[a-f0-9]{64}\n$/.test(original)) throw new JourneyError("failed", "repository_original_reference_invalid");
    const { artifact: firstBundle, bytes: originalBytes } = await bundle(files.firstBundle, firstRun.id);
    const initialGit = await inspectRepositoryBundle(originalBytes, { sourceCommit: source.commit, files: [files.context, files.first, "README"] });
    check("repository-first-commit-verified", repositoryCommitMatches(initialGit, { parent: source.commit, sourceReadme: source.readme,
      files: { [files.context]: original, [files.first]: "first\n", README: source.readme }, added: [files.context, files.first] }));
    check("repository-original-files-saved", repositoryWorkspaceFileMatches(await file(files.context), workspaceId, files.context, original)
      && repositoryWorkspaceFileMatches(await file(files.first), workspaceId, files.first, "first\n")
      && repositoryWorkspaceFileMatches(await file("README"), workspaceId, "README", source.readme));
    await retain("repository-first-observation.json", { source, projectId: project.id, workspaceId, issueId: created.issueId,
      runId: firstRun.id, referenceArtifact, initialGit, bundle: { attachmentId: firstBundle.attachmentId, sha256: firstBundle.sha256 } });
    const url = `${api.origin}/${company.issuePrefix}/issues/${first.currentIssue.identifier ?? created.issueId}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.reload();
    await browserDownload(firstBundle, "first-bundle");
    // The original random reference and commit are not supplied by this follow-up.
    await submitTaskReply(page, story.followup);
    const withReply = await waitFor(Math.min(options.deadlineAt, Date.now() + 30_000), read,
      state => state.comments.some(comment => comment.authorUserId === context.user.id && !first.comments.some(old => old.id === comment.id)),
      "repository_followup_not_stored");
    check("repository-followup-stored-once", fixtureReplyStoredOnce(first.comments, withReply.comments, context.user.id, story.followup));
    const final = await settled(2), lastRun = final.taskRuns[1]!;
    const finalView = await readObserved<Row>(`${route}/workspace`);
    check("repository-same-workspace-retained", binding(final.currentIssue, finalView, final.taskRuns)
      && Date.parse(lastRun.startedAt) >= Date.parse(firstRun.finishedAt));
    const { artifact: finalBundle, bytes: finalBytes } = await bundle(files.finalBundle, lastRun.id);
    const finalGit = await inspectRepositoryBundle(finalBytes,
      { sourceCommit: source.commit, files: [files.context, files.first, files.followup, "README"] });
    check("repository-second-commit-verified", repositoryCommitMatches(finalGit, { parent: initialGit.head, sourceReadme: source.readme,
      files: { [files.context]: original, [files.first]: "first\n", [files.followup]: "verified\n", README: source.readme }, added: [files.followup] }));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.reload();
    for (const [index, artifact] of [referenceArtifact!, firstBundle, finalBundle].entries()) await browserDownload(artifact, `reopened-${index}`);
    const [retained, retainedBundle] = await readRegisteredArtifacts(artifactApi, created.issueId, firstRun.id, [files.context, files.firstBundle]);
    check("repository-original-and-result-reopened", retained!.attachmentId === referenceArtifact!.attachmentId && retained!.content === original
      && retainedBundle!.attachmentId === firstBundle.attachmentId && retainedBundle!.sha256 === firstBundle.sha256
      && repositoryWorkspaceFileMatches(await file(files.context), workspaceId, files.context, original)
      && repositoryWorkspaceFileMatches(await file(files.first), workspaceId, files.first, "first\n")
      && repositoryWorkspaceFileMatches(await file(files.followup), workspaceId, files.followup, "verified\n")
      && repositoryWorkspaceFileMatches(await file("README"), workspaceId, "README", source.readme));
    check("configured-model-and-environment", true); // Both actual native runs passed validateAgentTaskState.
    await retain("repository-continuation-checks.json", { source, projectId: project.id, workspaceId, issueId: created.issueId,
      initialGit, finalGit, referenceArtifact, firstBundle, finalBundle, runIds: final.taskRuns.map(run => run.id) });
  } finally { await observations.preserve(options.directory); }
}

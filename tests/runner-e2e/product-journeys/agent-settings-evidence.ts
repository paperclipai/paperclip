import { createHash } from "node:crypto";

type Row = Record<string, any>;
export const AGENT_SETTINGS_CHECKS = [
  "agent-settings-browser-save", "agent-settings-reload-persisted", "agent-settings-instruction-only-input",
  "agent-settings-result-attributed", "agent-settings-result-reopened", "agent-settings-original-restored",
  "configured-model-and-environment",
] as const;
export const settingsDocumentKey = "settings-proof";
export const settingsProofHeading = "## QA settings persistence proof";
export const settingsTaskPrompt = "Follow the QA settings proof procedure in your saved agent instructions. Save the requested task document, then finish the task. No other tasks or agents are needed. Do not change your instruction files.";
export const instructionDigest = (content: string) => createHash("sha256").update(content).digest("hex");
export function settingsInstructionContent(original: string, reference: string) {
  return original + `\n\n${settingsProofHeading}\nWhen a task asks for the QA settings proof, save a task document with key ${settingsDocumentKey} and title Settings proof. Its body must be JSON with exactly two fields: reference equal to ${reference}, and settingsSaved equal to true. Keep these instructions unchanged.\n`;
}
export function settingsResultMatches(body: unknown, reference: string) {
  if (typeof body !== "string") return false;
  const text = body.trim(), json = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1] ?? text;
  try {
    const parsed = JSON.parse(json);
    return parsed && !Array.isArray(parsed) && Object.keys(parsed).sort().join(",") === "reference,settingsSaved"
      && parsed.reference === reference && parsed.settingsSaved === true;
  } catch { return false; }
}
export interface AgentSettingsScope {
  campaignId: string; companyId: string; userId: string; agentId: string; agentName: string;
  provider: string; model: string; environmentId: string; reference: string;
}
export interface SettingsSnapshot { agent: Row; bundle: Row; file: Row; runs: Row[]; activity: Row[]; renderedContent?: string }
export interface SettingsTaskSnapshot {
  issue: Row; runs: Row[]; interactions: Row[]; document: Row; revision: Row;
  reopenedDocument?: Row; reopenedRevision?: Row; renderedReference?: string;
}
export interface AgentSettingsEvidence {
  original?: SettingsSnapshot; saved?: SettingsSnapshot; reloaded?: SettingsSnapshot;
  afterWork?: SettingsSnapshot; restored?: SettingsSnapshot; task?: SettingsTaskSnapshot;
}
const present = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const revisionId = (point?: SettingsSnapshot) => point?.file?.revision?.id;
function snapshotBound(point: SettingsSnapshot | undefined, scope: AgentSettingsScope, entry?: string) {
  return Boolean(point && point.agent?.id === scope.agentId && point.agent.companyId === scope.companyId
    && point.agent.name === scope.agentName && point.agent.adapterType === "paperclip_runner"
    && point.agent.adapterConfig?.provider === scope.provider && point.agent.adapterConfig?.model === scope.model
    && point.bundle?.agentId === scope.agentId && point.bundle.companyId === scope.companyId
    && point.bundle.mode === "managed" && point.bundle.editable === true && present(point.bundle.entryFile)
    && (!entry || point.bundle.entryFile === entry) && point.file?.path === point.bundle.entryFile
    && point.file.isEntryFile === true && point.file.editable === true && point.file.binary !== true
    && typeof point.file.content === "string" && point.file.contentHash === instructionDigest(point.file.content)
    && point.file.size === Buffer.byteLength(point.file.content)
    && present(revisionId(point)) && point.file.revision.companyId === scope.companyId
    && point.file.revision.agentId === scope.agentId && point.file.revision.entryFile === point.bundle.entryFile
    && point.file.revision.contentHash === point.file.contentHash
    && point.file.revision.byteLength === point.file.size && Array.isArray(point.runs)
    && Array.isArray(point.activity) && point.activity.length < 200
    && point.activity.every(row => present(row.id) && row.companyId === scope.companyId
      && row.entityType === "agent" && row.entityId === scope.agentId));
}
export function matchedBoardSaveAudit(point: SettingsSnapshot | undefined, before: SettingsSnapshot | undefined, scope: AgentSettingsScope) {
  const old = new Set(before?.activity?.map(row => row.id));
  const added = point?.activity?.filter(row => !old.has(row.id) && row.action === "agent.files_updated"
    && row.entityType === "agent" && row.entityId === scope.agentId && row.details?.path === point.bundle.entryFile);
  if (!(Array.isArray(added) && added.length === 1 && present(added[0]?.id)
    && added[0].companyId === scope.companyId && added[0].actorType === "user" && added[0].actorId === scope.userId
    && added[0].agentId === null && added[0].runId === null && added[0].details.contentHash === point!.file.contentHash
    && added[0].details.source === "board")) return null;
  const row = added[0];
  return { id: row.id, companyId: row.companyId, actorType: row.actorType, actorId: row.actorId,
    agentId: row.agentId, runId: row.runId, action: row.action, entityType: row.entityType, entityId: row.entityId,
    path: row.details.path, contentHash: row.details.contentHash, source: row.details.source };
}
function boundIssue(run: Row) {
  const ids = [run.issueId, run.nativeIssueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].filter(value => value != null);
  return ids.length && ids.every(present) && new Set(ids).size === 1 ? ids[0] : undefined;
}
export function gradeAgentSettings(scope: AgentSettingsScope, value: AgentSettingsEvidence) {
  const { original, saved, reloaded, afterWork, restored, task } = value;
  const entry = original?.bundle?.entryFile;
  const scoped = [scope.campaignId, scope.companyId, scope.userId, scope.agentId, scope.agentName,
    scope.provider, scope.model, scope.environmentId, scope.reference].every(present)
    && scope.agentName.includes(scope.campaignId) && snapshotBound(original, scope)
    && original!.runs.length === 0 && !original!.file.content.includes(scope.reference)
    && !original!.file.content.includes(settingsProofHeading);
  const expected = scoped ? settingsInstructionContent(original!.file.content, scope.reference) : undefined;
  const save = scoped && snapshotBound(saved, scope, entry) && saved!.file.content === expected
    && revisionId(saved) !== revisionId(original) && matchedBoardSaveAudit(saved, original, scope) && saved!.runs.length === 0;
  const reload = save && snapshotBound(reloaded, scope, entry) && reloaded!.file.content === expected
    && revisionId(reloaded) === revisionId(saved) && reloaded!.renderedContent === expected && reloaded!.runs.length === 0;
  const issue = task?.issue, runs = task?.runs;
  const inputOnly = reload && issue && present(issue.id) && issue.companyId === scope.companyId
    && issue.assigneeAgentId === scope.agentId && issue.assigneeUserId === null && issue.createdByUserId === scope.userId
    && issue.createdByAgentId === null && issue.workMode === "standard" && issue.description === settingsTaskPrompt
    && !issue.description.includes(scope.reference);
  const run = Array.isArray(runs) && runs.length === 1 ? runs[0] : undefined;
  const provider = run?.runnerProfileJson?.nativeExecutionInput?.provider;
  const configured = Boolean(inputOnly && run && present(run.id) && run.companyId === scope.companyId
    && run.agentId === scope.agentId && boundIssue(run) === issue.id && run.status === "succeeded"
    && run.runtimeMode === "native" && run.nativePhase === "committed"
    && provider?.kind === scope.provider && provider.model === scope.model
    && run.contextSnapshot?.paperclipEnvironment?.id === scope.environmentId);
  const document = task?.document, revision = task?.revision;
  const output = configured && issue && issue.status === "done" && !issue.executionRunId && !issue.scheduledRetry && !issue.activeRecoveryAction
    && Array.isArray(task!.interactions) && task!.interactions.every(row => row.status !== "pending")
    && document && present(document.id) && document.companyId === scope.companyId && document.issueId === issue.id
    && document.key === settingsDocumentKey && document.createdByAgentId === scope.agentId && document.createdByUserId === null
    && present(document.latestRevisionId) && settingsResultMatches(document.body, scope.reference)
    && revision && revision.id === document.latestRevisionId && revision.documentId === document.id
    && revision.createdByAgentId === scope.agentId && revision.createdByUserId === null && revision.createdByRunId === run!.id
    && settingsResultMatches(revision.body, scope.reference)
    && snapshotBound(afterWork, scope, entry) && afterWork!.file.content === expected && revisionId(afterWork) === revisionId(saved)
    && afterWork!.runs.length === 1 && afterWork!.runs[0]?.id === run!.id;
  const reopened = task?.reopenedDocument, reopenedRevision = task?.reopenedRevision;
  const resultReload = output && issue && reopened && reopened.id === document.id && reopened.companyId === scope.companyId
    && reopened.issueId === issue.id && reopened.key === settingsDocumentKey && reopened.latestRevisionId === document.latestRevisionId
    && reopened.createdByAgentId === scope.agentId && reopened.createdByUserId === null && settingsResultMatches(reopened.body, scope.reference)
    && reopenedRevision && reopenedRevision.id === revision.id && reopenedRevision.documentId === document.id
    && reopenedRevision.createdByRunId === run!.id && reopenedRevision.createdByAgentId === scope.agentId
    && reopenedRevision.createdByUserId === null && settingsResultMatches(reopenedRevision.body, scope.reference)
    && task!.renderedReference === scope.reference;
  const restore = resultReload && snapshotBound(restored, scope, entry) && restored!.file.content === original!.file.content
    && restored!.renderedContent === original!.file.content && restored!.file.contentHash === original!.file.contentHash
    && revisionId(restored) === revisionId(original) && revisionId(restored) !== revisionId(saved) && matchedBoardSaveAudit(restored, afterWork, scope)
    && restored!.runs.length === 1 && restored!.runs[0]?.id === run!.id;
  return [save, reload, inputOnly, output, resultReload, restore, configured]
    .map((passed, index) => ({ id: AGENT_SETTINGS_CHECKS[index]!, passed: Boolean(passed) }));
}

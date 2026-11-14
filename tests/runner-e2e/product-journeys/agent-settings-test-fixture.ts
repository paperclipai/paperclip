import { instructionDigest, settingsInstructionContent, settingsDocumentKey, settingsTaskPrompt, type AgentSettingsEvidence, type AgentSettingsScope } from "./agent-settings-evidence.js";

export function settingsEvidenceFixture(reference = "1a2b3c4d5e6f", original = "# Ordinary instructions\nFollow the assigned task.\n", entryFile = "AGENTS.md") {
  const scope: AgentSettingsScope = { campaignId: "campaign-1", companyId: "company", userId: "user", agentId: "agent",
    agentName: "Owned agent campaign-1", environmentId: "environment", provider: "opencode", model: "model", reference };
  const saved = settingsInstructionContent(original, scope.reference);
  const run = { id: "run", companyId: scope.companyId, agentId: scope.agentId, nativeIssueId: "task", status: "succeeded",
    runtimeMode: "native", nativePhase: "committed", resultJson: { finalizationPhase: "committed" },
    contextSnapshot: { issueId: "task", paperclipEnvironment: { id: scope.environmentId } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: scope.provider, model: scope.model } } } };
  const snapshot = (content: string, runs: any[] = [], activity: any[] = []) => {
    const hash = instructionDigest(content);
    return { agent: { id: scope.agentId, companyId: scope.companyId, name: scope.agentName, adapterType: "paperclip_runner",
      adapterConfig: { provider: scope.provider, model: scope.model } },
    bundle: { agentId: scope.agentId, companyId: scope.companyId, entryFile, mode: "managed", editable: true,
      files: [{ path: entryFile, isEntryFile: true, editable: true },
        ...(entryFile !== "AGENTS.md" ? [{ path: "AGENTS.md", isEntryFile: false, editable: true }] : [])] },
    file: { path: entryFile, content, contentHash: hash, size: Buffer.byteLength(content), isEntryFile: true, editable: true,
      revision: { id: `agent-files:${hash}`, companyId: scope.companyId, agentId: scope.agentId, entryFile,
        contentHash: hash, byteLength: Buffer.byteLength(content), parentRevisionId: null, baseRevisionId: null, source: "api" } },
    runs, activity, renderedContent: content };
  };
  const audit = (id: string, content: string) => ({ id, companyId: scope.companyId, actorType: "user", actorId: scope.userId,
    agentId: null, runId: null, action: "agent.files_updated", entityType: "agent", entityId: scope.agentId,
    details: { path: entryFile, contentHash: instructionDigest(content), source: "board" } });
  const firstSave = audit("save", saved), restore = audit("restore", original);
  const body = JSON.stringify({ reference: scope.reference, settingsSaved: true });
  const document = { id: "document", companyId: scope.companyId, issueId: "task", key: settingsDocumentKey,
    body, latestRevisionId: "document-revision", createdByAgentId: scope.agentId, createdByUserId: null };
  const revision = { id: "document-revision", documentId: document.id, body, createdByRunId: run.id,
    createdByAgentId: scope.agentId, createdByUserId: null };
  const evidence: AgentSettingsEvidence = {
    original: snapshot(original), saved: snapshot(saved, [], [firstSave]), reloaded: snapshot(saved, [], [firstSave]),
    afterWork: snapshot(saved, [run], [firstSave]), restored: snapshot(original, [run], [firstSave, restore]),
    task: { issue: { id: "task", companyId: scope.companyId, assigneeAgentId: scope.agentId, assigneeUserId: null,
      createdByUserId: scope.userId, createdByAgentId: null, workMode: "standard", description: settingsTaskPrompt, status: "done" },
    runs: [run], interactions: [], document, revision, reopenedDocument: { ...document }, reopenedRevision: { ...revision }, renderedReference: scope.reference },
  };
  return { scope, evidence, original, saved, run, firstSave, restore };
}

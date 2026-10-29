import { createHash } from "node:crypto";

export const MAX_MANUAL_PRIVATE_CELLS = 8;
export const MANUAL_PRIVATE_PROTOCOL = "paperclip.manual-private-evidence/v1";
export const MANUAL_PRIVATE_EXECUTIONS = Object.freeze([
  "activity.agent-feedback",
  "activity.work-timeline",
  "companies.import-preview",
  "navigation-preferences.dismiss-announcement",
  "tasks.completion-with-gate",
  "tasks.private-task",
  "secrets.personal-secret",
  "agents.choose-primary",
  "access.cli-authorization",
  "access.invite-teammate",
  "access.manage-membership",
  "access.other-company",
  "access.private-resource",
  "access.sign-in",
  "activity.audit-change",
  "activity.company-overview",
  "activity.find-runs",
  "activity.routine-audit",
  "agent-chat.chat-disabled",
  "agent-chat.conference-room",
  "agent-chat.multiple-handoffs",
  "agent-chat.remember-and-follow-up",
  "agent-chat.reopen-conversation",
  "agent-chat.track-delegated-work",
  "agents.agent-api-key",
  "agents.ambiguous-cloud-code",
  "agents.change-manager",
  "agents.configure-required-agent",
  "agents.edit-instructions",
  "agents.existing-grok-bot",
  "agents.hire-claude-code",
  "agents.hire-denied",
  "agents.hire-needs-account",
  "agents.hire-needs-approval",
  "agents.managed-profile",
  "agents.pause-agent",
  "agents.restore-instructions",
  "agents.resume-agent",
  "agents.retire-agent",
  "app-permissions.ask-before-action",
  "app-permissions.grant-one-agent",
  "app-permissions.new-quarantined-action",
  "app-permissions.read-allowed-write-off",
  "app-permissions.revoke-account",
  "app-permissions.test-as-agent",
  "assistant-connections.connect-external-assistant",
  "assistant-connections.consent-read-only",
  "assistant-connections.decline-consent",
  "assistant-connections.device-login",
  "assistant-connections.revoke-personal-grant",
  "assistant-connections.use-scoped-client",
  "budgets-costs.explain-hard-stop",
  "budgets-costs.repair-cost-recording",
  "budgets-costs.resolve-budget",
  "budgets-costs.set-budget",
  "budgets-costs.spend-breakdown",
  "budgets-costs.subscription-fees",
  "cases.browse-cases",
  "cases.case-history",
  "cases.cases-disabled",
  "cases.close-case",
  "cases.create-case",
  "cases.handoff-same-task",
  "cases.related-work",
  "cases.update-case-facts",
  "chat-channels.channel-file",
  "chat-channels.connect-slack",
  "chat-channels.link-sender",
  "chat-channels.outbound-email",
  "chat-channels.provider-disabled",
  "chat-channels.repair-endpoint",
  "chat-channels.reply-in-thread",
  "chat-channels.reply-to-email",
  "cli-operations.choose-cli-context",
  "cli-operations.create-from-cli",
  "cli-operations.export-document-cli",
  "cli-operations.feedback-bundle",
  "cli-operations.inspect-run-cli",
  "cli-operations.owned-dev-instance",
  "companies.agent-observability",
  "companies.archive-company",
  "companies.configure-decision-model",
  "companies.export-company",
  "companies.fast-responses",
  "companies.prompt-injection-guard",
  "companies.rename-company",
  "companies.switch-company",
  "connection-setup.channel-prerequisites",
  "connection-setup.choose-provider",
  "connection-setup.notion-agent-unassigned",
  "connection-setup.notion-connected",
  "connection-setup.notion-declined",
  "connection-setup.notion-expired",
  "connection-setup.notion-missing",
  "connection-setup.notion-wrong-account",
  "connection-setup.return-from-login",
  "connection-setup.save-and-resume",
  "connection-setup.secure-api-key",
  "connection-setup.unreachable-mcp",
  "connection-setup.wrong-person-resolves",
  "developer-labs.component-reference",
  "developer-labs.gated-lab",
  "developer-labs.interaction-fixture",
  "developer-labs.long-thread-performance",
  "documents-artifacts.find-artifact",
  "documents-artifacts.private-download",
  "documents-artifacts.produce-download",
  "documents-artifacts.resolve-feedback",
  "documents-artifacts.restore-document",
  "documents-artifacts.revise-delivery",
  "documents-artifacts.write-plan",
  "execution-environments.add-computer",
  "execution-environments.assign-computer",
  "execution-environments.choose-capable-target",
  "execution-environments.prepare-image",
  "execution-environments.test-computer",
  "gateways-profiles.connect-client",
  "gateways-profiles.create-gateway",
  "gateways-profiles.define-profile",
  "gateways-profiles.inspect-gateway-error",
  "gateways-profiles.rotate-token",
  "goals.align-existing-work",
  "goals.create-goal-tree",
  "goals.explain-purpose",
  "inbox-search.archive-done",
  "inbox-search.archive-partial-failure",
  "inbox-search.archive-without-grant",
  "inbox-search.find-design",
  "inbox-search.notification-audience",
  "inbox-search.restore-archive",
  "inbox-search.show-decisions",
  "inbox-search.show-my-work",
  "instance-operations.backup-and-restore",
  "instance-operations.diagnose-health",
  "instance-operations.instance-settings",
  "instance-operations.provision-runtime",
  "instance-operations.restart-service",
  "instance-operations.update-instance",
  "navigation-preferences.broken-link",
  "navigation-preferences.edit-profile",
  "navigation-preferences.find-project-view",
  "navigation-preferences.quick-search",
  "navigation-preferences.sidebar-order",
  "onboarding.choose-first-runtime",
  "onboarding.first-work",
  "onboarding.new-company",
  "onboarding.new-instance",
  "onboarding.resume-wizard",
  "plugins.configure-plugin",
  "plugins.disable-plugin",
  "plugins.install-plugin",
  "plugins.use-plugin-tool",
  "projects.add-repository",
  "projects.archive-project",
  "projects.create-project",
  "projects.private-project",
  "projects.project-defaults",
  "projects.project-work",
  "projects.replace-repository",
  "projects.share-project",
  "questions-and-approvals.accept-one-proposal",
  "questions-and-approvals.ambiguous-yes",
  "questions-and-approvals.approve-tool-once",
  "questions-and-approvals.decline-tool",
  "questions-and-approvals.defer-and-reopen",
  "questions-and-approvals.duplicate-answer",
  "questions-and-approvals.formal-hire-revision",
  "questions-and-approvals.multi-part-question",
  "questions-and-approvals.necessary-question",
  "questions-and-approvals.reject-and-revise",
  "questions-and-approvals.review-plan",
  "questions-and-approvals.wrong-reviewer",
  "recovery.browser-reconnect",
  "recovery.controller-restart",
  "recovery.explain-stall",
  "recovery.post-stop-message",
  "recovery.retry-exhausted",
  "recovery.source-action",
  "recovery.unknown-email-outcome",
  "recovery.workspace-repair",
  "routines.create-daily-brief",
  "routines.manage-other-owner",
  "routines.pause-owned",
  "routines.plugin-managed-routine",
  "routines.read-history",
  "routines.run-now",
  "routines.webhook-trigger",
  "runs-adapters.inspect-failed-run",
  "runs-adapters.list-model-options",
  "runs-adapters.reset-session",
  "runs-adapters.upgrade-runner",
  "runs-adapters.validate-hire",
  "secrets.ask-for-plaintext",
  "secrets.configure-company-secret",
  "secrets.least-scope-delivery",
  "secrets.secret-proposal",
  "secrets.vault-reference",
  "skills.author-skill",
  "skills.enable-for-agent",
  "skills.explicit-restriction",
  "skills.find-and-install",
  "skills.fork-read-only",
  "skills.review-update",
  "skills.studio-test",
  "status-cards.archive-card",
  "status-cards.create-card",
  "status-cards.explain-card",
  "status-cards.other-authors-card",
  "status-cards.refresh-card",
  "steering.approval-delivery",
  "steering.discard-queued-message",
  "steering.edit-queued-message",
  "steering.interrupt-with-direction",
  "steering.preserve-draft",
  "steering.queue-follow-up",
  "steering.steer-active",
  "steering.stop-versus-pause",
  "task-coordination.block-on-design",
  "task-coordination.delegate-with-context",
  "task-coordination.independent-review",
  "task-coordination.pause-tree",
  "task-coordination.reject-dependency-cycle",
  "tasks.ambiguous-task",
  "tasks.assignment-conflict",
  "tasks.attachment-brief",
  "tasks.comment-with-reference",
  "create-backlog",
  "delegate-announcement",
  "tasks.edit-properties",
  "tasks.organize-open-work",
  "tasks.share-private-task",
  "tasks.website-task",
  "tasks.website-without-project",
  "teams.configure-team",
  "teams.find-team",
  "teams.install-team",
  "teams.preview-install",
  "workspaces.close-and-reopen",
  "workspaces.inspect-git",
  "workspaces.locate-files",
  "workspaces.prepare-repository",
  "workspaces.preview-service",
  "workspaces.private-repository-no-access",
  "workspaces.recover-lost-sandbox",
].map(id => `chat-features.runner-opencode.local.${id}`));
const sha = /^[0-9a-f]{40}$/;
const execution = /^[A-Za-z0-9][A-Za-z0-9._-]{0,249}$/;
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...expected].sort().join();
}
export function canonicalManualIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32
    || value.some(id => typeof id !== "string" || !execution.test(id)) || new Set(value).size !== value.length)
    throw new Error("Invalid exact manual evidence selection");
  return [...value].sort();
}
export function canonicalPrivateManualIds(value: unknown): string[] {
  const ids = canonicalManualIds(value);
  if (ids.length > MAX_MANUAL_PRIVATE_CELLS) throw new Error("Private manual evidence exceeds the per-run cell limit");
  return ids;
}
export function requiresPrivateManualEvidence(id: string) {
  return id === "chat-features" || id.startsWith("chat-features.");
}
export interface ManualRetentionIdentity {
  workflowSha: string; targetSha: string; runId: string; attempt: string; executionIds: string[];
}
export function authorizeManualPrivateEvidence(identity: ManualRetentionIdentity, approvalJson: string) {
  if (!sha.test(identity.workflowSha) || !sha.test(identity.targetSha) || !/^[1-9][0-9]{0,19}$/.test(identity.runId) || identity.attempt !== "1")
    throw new Error("Invalid manual private evidence identity");
  const ids = canonicalPrivateManualIds(identity.executionIds);
  if (ids.some(id => !MANUAL_PRIVATE_EXECUTIONS.includes(id))) throw new Error("Unsupported private manual evidence selection");
  if (Buffer.byteLength(approvalJson) > 65536) throw new Error("Invalid protected manual evidence approval");
  let policy: unknown;
  try { policy = JSON.parse(approvalJson); } catch { throw new Error("Invalid protected manual evidence approval"); }
  if (!keys(policy, ["version", "approvals"]) || policy.version !== 1 || !Array.isArray(policy.approvals) || policy.approvals.length > 32)
    throw new Error("Invalid protected manual evidence approval");
  const matches = policy.approvals.filter(row => {
    if (!keys(row, ["workflowSha", "targetSha", "runId", "attempt", "executionIds", "protocol", "launchSha256"]) || !sha.test(String(row.workflowSha))
      || !sha.test(String(row.targetSha)) || !/^[1-9][0-9]{0,19}$/.test(String(row.runId)) || row.attempt !== "1" || row.protocol !== MANUAL_PRIVATE_PROTOCOL || !/^[0-9a-f]{64}$/.test(String(row.launchSha256)))
      throw new Error("Invalid protected manual evidence approval");
    const selected = canonicalPrivateManualIds(row.executionIds);
    return row.workflowSha === identity.workflowSha && row.targetSha === identity.targetSha && row.runId === identity.runId && row.attempt === identity.attempt && selected.join() === ids.join();
  });
  if (matches.length !== 1) throw new Error("Exact protected manual evidence approval missing or ambiguous");
  return Object.freeze({ ...identity, executionIds: Object.freeze(ids), protocol: MANUAL_PRIVATE_PROTOCOL,
    launchSha256: String(matches[0]!.launchSha256), approvalSha256: createHash("sha256").update(approvalJson).digest("hex"), private: true as const });
}
export function manualCellKind(id: string) {
  if (!execution.test(id)) throw new Error("Invalid manual evidence execution identity");
  return `manual-cell-${createHash("sha256").update(id).digest("hex")}`;
}
export function manualPrivateSessionPolicy(input: { bucket: string; runId: string; executionIds: string[]; mode: "cell-write" | "cell-read" | "report-write" }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) || !/^[1-9][0-9]{0,19}$/.test(input.runId))
    throw new Error("Invalid manual private storage identity");
  const ids = canonicalPrivateManualIds(input.executionIds);
  if (ids.some(id => !MANUAL_PRIVATE_EXECUTIONS.includes(id)) || input.mode !== "report-write" && ids.length !== 1)
    throw new Error("Private archive sessions require one exact cell or the report writer");
  const prefix = `arn:aws:s3:::${input.bucket}/runner-e2e-private/bounded-v1/campaigns/gha-${input.runId}-1/`;
  const cells = ids.map(id => `${prefix}${manualCellKind(id)}.zip`);
  const policy = { Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: ["s3:GetBucketVersioning", "s3:GetLifecycleConfiguration", "s3:GetBucketObjectLockConfiguration", "s3:GetReplicationConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketOwnershipControls", "s3:GetBucketPolicy"], Resource: `arn:aws:s3:::${input.bucket}` },
    ...(input.mode === "cell-read" ? [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: cells.flatMap(key => [key, `${key}.upload-receipt.json`]) }] : []),
    ...(input.mode === "cell-read" ? [] : [{ Effect: "Allow", Action: ["s3:PutObject"], Resource: (input.mode === "report-write" ? [`${prefix}manual-report.zip`] : cells).flatMap(key => [key, `${key}.upload-receipt.json`]) }]),
  ] };
  if (JSON.stringify(policy).length > 2048) throw new Error("Private archive session policy exceeds the STS limit");
  return policy;
}

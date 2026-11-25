// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ConnectionGrant, DocumentRevision } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountQuotaPanels } from "@/components/AccountQuotaPanels";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { AiConnectionAccountControls } from "@/components/ai-connections/AiConnectionAccountControls";
import { AiConnectionIdentity } from "@/components/ai-connections/AiConnectionIdentity";
import { AiConnectionPicker } from "@/components/ai-connections/AiConnectionPicker";
import { AiConnectionPoolRunDetails } from "@/components/ai-connections/AiConnectionPoolRunDetails";
import { DocumentDiffModal } from "@/components/DocumentDiffModal";
import { CopyField } from "@/components/routine-triggers/WebhookFields";
import { RunInvocationCard } from "@/components/run-log/RunDetails";
import { ChatConversationList } from "@/pages/apps/chat/ChatConversationList";
import { VoiceTranscript } from "@/components/voice/VoiceTranscript";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { IssueQuicklookCard } from "@/components/IssueLinkQuicklook";
import * as CompanyContext from "@/context/CompanyContext";
import * as MarkdownPlainText from "@/lib/markdown-plain-text";
import { buildPostHogInitOptions } from "./product-analytics";
import {
  ANALYTICS_MASK_CLASS,
  ANALYTICS_MASK_TEXT_SELECTOR,
  ANALYTICS_NO_CAPTURE_CLASS,
  ANALYTICS_WORK_CONTENT_CLASS,
  REPLAY_WORK_CONTENT_ATTRIBUTE,
  maskReplayText,
  redactReplaySecrets,
  workContentClassForCompany,
} from "./privacy";
import { isBlockedFromReplay, replayLeaks } from "./replay-recording.test-utils";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const stars = (text: string) => text.replace(/\S/g, "*");

const UI_SRC = join(import.meta.dirname, "../..");

const options = buildPostHogInitOptions(
  { token: "t", apiHost: "/_ph", uiHost: null, environment: "production", stackId: "s", replayEnabled: true },
  "acme.paperclip.app",
);

function recordedText(node: Text): string {
  const parent = node.parentElement;
  const masked = parent?.closest(options.session_recording.maskTextSelector) != null;
  // Like rrweb: text inside the selector goes through `maskTextFn`.
  return masked ? options.session_recording.maskTextFn(node.data, parent) : node.data;
}

function recordedTextOf(html: string, text: string): string {
  document.body.innerHTML = html;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes(text)) return recordedText(node);
  }
  throw new Error(`text not rendered: ${text}`);
}

function renderTaskPreview(description: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <IssueQuicklookCard
        issue={{
          id: "task-1", companyId: "co-1", title: "Review access", status: "todo",
          priority: "medium", updatedAt: new Date(0), description,
        }}
        linkTo="/ACME/issues/ACME-1"
      />
    </MemoryRouter>,
  );
}

/**
 * Work content: masked unless the company holds no Google or Slack data
 * (`ANALYTICS_WORK_CONTENT_CLASS`). Task descriptions, document bodies and
 * artifact contents.
 */
const WORK_CONTENT_SURFACES: Array<{ file: string; content: string }> = [
  { file: "components/IssueLinkQuicklook.tsx", content: "data-slot=\"task-preview-description\"" },
  { file: "components/task-side-panel/TaskAttachmentPanel.tsx", content: "File is empty." },
  { file: "components/artifacts/ArtifactCard.tsx", content: "{preview}" },
  { file: "components/artifacts/RichArtifactCards.tsx", content: "<PatchLines text={body} />" },
  { file: "components/artifacts/RichArtifactCards.tsx", content: "<ReactMarkdown" },
  { file: "components/artifacts/RichArtifactCards.tsx", content: "{columns.map(" },
  { file: "components/FileViewerSheet.tsx", content: "{lines.map(" },
];

const MASKED_SURFACES: Array<{ file: string; content: string }> = [
  { file: "components/LinkPreview.tsx", content: "{preview.title}" },
  { file: "components/LinkPreview.tsx", content: "{target.canonicalUrl}" },
  { file: "components/ExternalObjectPill.tsx", content: "{valueLabel}" },
  { file: "components/ExternalObjectPill.tsx", content: "{labelText}" },
  { file: "components/issue-properties/external-object-rows.tsx", content: "{displayKey}</span>" },
  { file: "components/issue-properties/external-object-rows.tsx", content: "{value}</span>" },
  { file: "components/IssueRelatedWorkPanel.tsx", content: "{pill.displayTitle}" },
  { file: "components/EmailMessageCard.tsx", content: "{message.subject" },
  { file: "components/EmailTaskActivity.tsx", content: "{p.request.subject" },
  { file: "pages/apps/Browse.tsx", content: "{accountName}\n          </button>" },
  { file: "pages/apps/Browse.tsx", content: "{connectionToRemove?.accountName" },
  { file: "pages/apps/Browse.tsx", content: "“{connection.name}”" },
  { file: "pages/apps/Connections.tsx", content: ">{row.displayName}</span>" },
  { file: "pages/apps/AppDetail.tsx", content: "<h1 className={cn(\"text-xl font-semibold\", ANALYTICS_MASK_CLASS)}>{appName}" },
  { file: "pages/apps/AppDetail.tsx", content: "<h1 className={cn(\"truncate text-xl font-bold\", ANALYTICS_MASK_CLASS)}>{appName}" },
  { file: "components/AppConnectionSidebar.tsx", content: "{appName}</span>" },
  { file: "features/connections/ConnectionChoiceList.tsx", content: ">{choice.name}</span>" },
  { file: "features/connections/ConnectionIntentInteractionBody.tsx", content: "${accessRequest.connectionName}" },
  { file: "features/connections/ConnectionIntentInteractionBody.tsx", content: "“{accessRequest.connectionName}”" },
  { file: "features/connections/ConnectionIntentInteractionBody.tsx", content: "{repair.connection.name} is ready." },
  { file: "features/connections/ConnectionIntentInteractionBody.tsx", content: "must reconnect ${repair.connection.name}" },
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", content: "<span className={ANALYTICS_MASK_CLASS}>@{github.login}</span>" },
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", content: "@{github.login}\n" },
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", content: "<Identity name={connectedName}" },
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", content: "<AlertDialogTitle className={ANALYTICS_MASK_CLASS}>{title}" },
  { file: "pages/apps/AggregatorAppManager.tsx", content: "{account.alias ||" },
  { file: "pages/apps/AggregatorAppManager.tsx", content: "“{connection.name}”" },
  { file: "pages/apps/ComposioAppManager.tsx", content: "{account.alias ||" },
  { file: "pages/apps/ComposioAppManager.tsx", content: "“{connection.name}”" },
  { file: "pages/apps/TailscaleConnector.tsx", content: "{connected.map(connection => connection.name)" },
  { file: "pages/apps/TailscaleConnector.tsx", content: "{connection.name}</p>" },
  { file: "pages/apps/TailscaleConnector.tsx", content: "<span className={ANALYTICS_MASK_CLASS}>{connection.name}</span></Button>\n" },
  { file: "pages/apps/TailscaleConnector.tsx", content: "<span className={ANALYTICS_MASK_CLASS}>{connection.name}</span></Button>}" },
  { file: "pages/apps/ArcadeDiscoverySetup.tsx", content: "“{connection.name}”" },
  { file: "pages/apps/ExecutorManagementSetup.tsx", content: "“{connection.name}”" },
  { file: "pages/apps/AggregatorConnectDialog.tsx", content: "{existing.map(" },
  { file: "pages/apps/app-detail/ConnectedAggregatorApps.tsx", content: "{accounts[0].alias}" },
  { file: "pages/apps/chat/GitHubBotConfiguration.tsx", content: "@{person.login}</p>" },
  { file: "pages/apps/chat/GitHubBotConfiguration.tsx", content: "`@${candidate.login} is already listed" },
  { file: "pages/apps/chat/GitHubChatSetup.tsx", content: "{legacyIdentity?.login}" },
  { file: "pages/apps/chat/GitHubChatSetup.tsx", content: "{state.identity.login}" },
  { file: "pages/apps/chat/GitHubChatSetup.tsx", content: "{account.login ?? account.name}" },
  { file: "pages/apps/chat/GitHubChatSetup.tsx", content: "{legacyIdentity.login}" },
  { file: "pages/apps/chat/GitHubChatSetup.tsx", content: "{knownOrganizations.map(" },
  { file: "pages/AgentDetail.tsx", content: "{person?.user?.name ?? person?.user?.email" },
  { file: "pages/AgentDetail.tsx", content: "{responsibleUserName ?? responsibleUserLabel(null)}" },
  { file: "pages/AgentToolsTab.tsx", content: "{connection.name}</span>" },
  { file: "pages/AgentToolsTab.tsx", content: "{connectionNameById.get(tool.connectionId) ?? \"—\"}" },
  { file: "pages/tools/connection-dialogs.tsx", content: "<span className={ANALYTICS_MASK_CLASS}>{connection.name}</span></DialogTitle>" },
  { file: "pages/tools/AuditTab.tsx", content: "{connectionName}\n" },
  { file: "pages/tools/profiles/ProfileDetail.tsx", content: "{tool.applicationName ?? tool.connectionName" },
  { file: "features/connections/ConnectionInstructions.tsx", content: "{connection.name}</Link>" },
  { file: "components/decision-models/DecisionHistory.tsx", content: "{row.connectionName ??" },
  { file: "components/IssueThreadInteractionCard.tsx", content: "<span className={ANALYTICS_MASK_CLASS}>{connectionName}</span>" },
  { file: "components/ai-connections/AiConnectionField.tsx", content: "For you: ${pendingAccount" },
  { file: "components/ai-connections/AiConnectionField.tsx", content: "{compatiblePools.map(" },
  { file: "components/ai-connections/AiConnectionPoolConnector.tsx", content: "{account?.name ?? \"Connection unavailable\"}" },
  { file: "components/ai-connections/AiConnectionPoolConnector.tsx", content: "{account.name}</span>" },
  { file: "components/ai-connections/AiConnectionPoolConnector.tsx", content: "Remove {draft.name}?" },
  { file: "components/TailscaleSshMachine.tsx", content: "{connected.map(connection => <option" },
  { file: "features/connections/ConnectionInstructions.tsx", content: "{value.text}</p>" },
  { file: "features/connections/ConnectionInstructions.tsx", content: "{connection.agentInstructions!.text}</p>" },
  { file: "pages/AgentDetail.tsx", content: "{run.stderrExcerpt}</pre>" },
  { file: "pages/AgentDetail.tsx", content: "{run.stdoutExcerpt}</pre>" },
  { file: "pages/ExecutionWorkspaceDetail.tsx", content: "{operation.stderrExcerpt}</div>" },
  { file: "pages/ExecutionWorkspaceDetail.tsx", content: "{operation.stdoutExcerpt}</div>" },
  { file: "components/RunnerInspector.tsx", content: "<Search className=\"absolute left-2.5" },
  { file: "pages/apps/chat/GitHubConnectionComplete.tsx", content: "{endpoint.providerAccountLabel}\n" },
  { file: "components/chat/AgentChannelsPanel.tsx", content: "{endpoint.botLabel ??" },
  { file: "pages/apps/Connections.tsx", content: "<table className=\"w-full text-sm\">" },
  { file: "components/skill-studio/SkillSourceConnectionRepair.tsx", content: "<RadioCardGroup ariaLabel=\"GitHub connection\"" },
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", content: "{grantAccountLabel(grant)}" },
  { file: "pages/apps/chat/slack/ManagedSlackSetup.tsx", content: "{workspaces[0]!.workspaceName}" },
  { file: "pages/apps/chat/slack/ManagedSlackSetup.tsx", content: "<SelectValue" },
  { file: "pages/apps/chat/slack/ManagedSlackSetup.tsx", content: "{workspace.workspaceName}" },
  { file: "pages/apps/chat/ChatEndpointDetail.tsx", content: "{resource.label}" },
  { file: "pages/apps/chat/ChatEndpointDetail.tsx", content: "{link.paperclipUserLabel ?? link.externalLabel}</p>" },
  { file: "pages/apps/chat/ChatConversationList.tsx", content: "{conversationDestination(row, provider)}" },
  { file: "pages/apps/chat/ChatConversationList.tsx", content: "{row.externalLabel}" },
  { file: "pages/apps/chat/ChatIdentityConfirm.tsx", content: "Future messages from {identity.externalLabel}" },
  { file: "pages/apps/chat/ChatIdentityConfirm.tsx", content: "{identity.externalDetail ?" },
  { file: "pages/apps/chat/SlackIdentityStep.tsx", content: "{identity.externalLabel}</p>" },
  { file: "components/AccountQuotaPanels.tsx", content: "{account.accountLabel ?? \"Subscription account\"}" },
  { file: "components/ai-connections/AiConnectionAccountDetails.tsx", content: "{accountLabel ?? \"Not available\"}" },
  { file: "components/ai-connections/AiConnectionAccountDetails.tsx", content: "{identity.data?.organizationLabel ??" },
  { file: "components/ai-connections/AiConnectionAccountControls.tsx", content: "` · ${account.accountLabel}`" },
  { file: "components/ai-connections/AiConnectionIdentity.tsx", content: "` · ${connection.accountLabel}`" },
  { file: "components/ai-connections/AiConnectionPoolRunDetails.tsx", content: "Task-pinned pool account · {account?.accountName" },
  { file: "components/AdapterLoginChrome.tsx", content: "{login?.accountLabel ?? provider} is signed in." },
  { file: "components/chat/ExternallyConnectedTaskBanner.tsx", content: "{binding.externalLabel} ·" },
  { file: "pages/apps/chat/ChatEndpointDetail.tsx", content: "Confirm {confirmationFor" },
  { file: "components/ai-connections/AiConnectionSelect.tsx", content: "{label ?? aiConnectionDisplayLabel(connection)}" },
  { file: "components/voice/SpekoCallHistory.tsx", content: "{report.transcript.map(" },
  { file: "pages/CaseDetail.tsx", content: "{caseData.summary}" },
  { file: "pages/CaseDetail.tsx", content: "{files.map(" },
  { file: "components/CaseFieldsPanel.tsx", content: "aria-label=\"Case fields\"" },
  { file: "components/AttentionQueueRow.tsx", content: "{detailLine}" },
  { file: "components/AttentionObligationEvidence.tsx", content: "{attentionEvidenceLabel(item, entry)}" },
  { file: "components/coordinator/NeedsYouCardKit.tsx", content: "{children}</p>" },
  { file: "components/coordinator/NeedsYouCardParts.tsx", content: "{receipt.reason}" },
  { file: "components/coordinator/CoordinatorDecisionReceipt.tsx", content: "Reason: {item.reason}" },
  { file: "components/coordinator/CoordinatorDecisionReceipt.tsx", content: "{decisionHistoryHeadline(item, userLabelMap)}" },
  { file: "components/coordinator/CoordinatorNeedsYou.tsx", content: "<h2>{title}</h2>" },
  { file: "components/DecisionCard.tsx", content: "{option.description}" },
  { file: "components/DecisionCard.tsx", content: "{row.summary}" },
  { file: "components/DecisionResolver.tsx", content: "{decision.title}" },
  { file: "components/TaskDecisionRecord.tsx", content: "{decision.inputValues![input.id]}" },
  { file: "components/IssueThreadInteractionCard.tsx", content: "<SuggestTasksCard" },
  { file: "components/IssueThreadInteractionCard.tsx", content: "<ConnectionIntentInteractionBody" },
  { file: "components/IssueThreadInteractionCard.tsx", content: "<CompactDecisionAsk><PromptText>{compactTitle}" },
  { file: "components/IssueRecoveryActionCard.tsx", content: "{headline}" },
  { file: "components/IssueRecoveryActionCard.tsx", content: "{evidenceSummary.text}\n" },
  { file: "components/IssueRecoveryActionCard.tsx", content: ">{evidenceSummary.text}</span>" },
  { file: "components/IssueRunLedger.tsx", content: "{retryState.secondary}" },
  { file: "components/ToastViewport.tsx", content: "{toast.title}" },
  { file: "components/ToastViewport.tsx", content: "{toast.body}" },
  { file: "components/interrupt-handoff/InterruptHandoffViews.tsx", content: "{preview.text}" },
  { file: "components/interrupt-handoff/InterruptHandoffViews.tsx", content: "{bucket.detail}" },
  { file: "components/ApprovalPayload.tsx", content: "{String(value)}" },
  { file: "components/ApprovalPayload.tsx", content: "{String(payload.guidance)}" },
  { file: "components/ApprovalPayload.tsx", content: "{proposedComment}" },
  { file: "components/ApprovalPayload.tsx", content: "{String(plan)}" },
  { file: "components/actions/ActionCard.tsx", content: "{json}" },
  { file: "components/actions/ActionCard.tsx", content: "{reason}" },
  { file: "components/run-log/LogViewer.tsx", content: "{evt.message" },
  { file: "components/run-log/LogViewer.tsx", content: "{redactPathText(run.stderrExcerpt" },
  { file: "components/run-log/RunDetails.tsx", content: "redactPathText(payload.prompt" },
  { file: "components/run-log/RunDetails.tsx", content: "redactPathValue(payload.context" },
  { file: "components/run-log/RunDetails.tsx", content: "formatEnvForDisplay(payload.env" },
  { file: "components/DocumentDiffModal.tsx", content: "{row.text.length > 0" },
  { file: "components/CaseRevisionRail.tsx", content: "{row.text.length > 0" },
  { file: "pages/apps/app-detail/ActionTestDialog.tsx", content: "<RawResponseDisclosure value={value}" },
  { file: "pages/apps/app-detail/ActionTestDialog.tsx", content: "<RawResponseDisclosure value={outcome.result.result}" },
  { file: "components/search/SearchResultRow.tsx", content: "<HighlightedText\n        text={text}" },
];

function tagEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = null;
    } else if (c === "\"" || c === "'" || c === "`") {
      if (depth === 0 && c === "`") continue;
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    } else if (c === ">" && depth === 0) {
      return i;
    }
  }
  return source.length;
}

function openElementsAt(source: string, index: number): string[] {
  const stack: Array<{ name: string; tag: string }> = [];
  const tagStart = /(?<![\w.)\]])<(\/?)([A-Za-z][\w.]*)?(?=[\s>/])/g;
  for (let match = tagStart.exec(source); match && match.index < index; match = tagStart.exec(source)) {
    const end = tagEnd(source, match.index + 1);
    const tag = source.slice(match.index, end + 1);
    const name = match[2] ?? "";
    if (match[1]) {
      const open = stack.map((entry) => entry.name).lastIndexOf(name);
      if (open >= 0) stack.length = open;
    } else if (!tag.endsWith("/>") && end >= index) {
      stack.push({ name, tag });
    } else if (!tag.endsWith("/>")) {
      stack.push({ name, tag });
    }
    tagStart.lastIndex = end + 1;
  }
  return stack.map((entry) => entry.tag);
}

const CONNECTION_SURFACE_DIRS = ["pages/apps", "features/connections", "components/ai-connections"];
const PORTAL_TAG = /<(DialogContent|AlertDialogContent|SelectContent|SelectTrigger|PopoverContent|DropdownMenuContent|SheetContent|TooltipContent)\b/g;

function connectionSurfaceFiles(dir: string): string[] {
  return readdirSync(join(UI_SRC, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(UI_SRC, path)).isDirectory()) return connectionSurfaceFiles(path);
    return /\.tsx$/.test(name) && !/\.(test|stories)\.tsx$/.test(name) ? [path] : [];
  });
}

const CONNECTION_PORTALS = CONNECTION_SURFACE_DIRS.flatMap(connectionSurfaceFiles).flatMap((file) => {
  const source = readFileSync(join(UI_SRC, file), "utf8");
  return [...source.matchAll(PORTAL_TAG)].map((match) => ({
    file,
    line: source.slice(0, match.index).split("\n").length,
    tag: source.slice(match.index, tagEnd(source, match.index! + 1) + 1),
  }));
});

describe("session replay text masking", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("records unmarked chrome text as it is", () => {
    const html = `<nav><a>Tasks</a><a>Inbox</a></nav><h1>Q3 launch plan</h1><button>New task</button>`;
    expect(recordedTextOf(html, "Tasks")).toBe("Tasks");
    expect(recordedTextOf(html, "Q3 launch plan")).toBe("Q3 launch plan");
    expect(recordedTextOf(html, "New task")).toBe("New task");
  });

  it("masks text inside each marker, at any depth", () => {
    expect(recordedTextOf(`<div class="${ANALYTICS_MASK_CLASS}"><p><span>Re: contract</span></p></div>`, "Re: contract")).toBe("*** ********");
    expect(recordedTextOf(`<div class="${ANALYTICS_NO_CAPTURE_CLASS}"><span>sk-123</span></div>`, "sk-123")).toBe("******");
    expect(recordedTextOf(`<div contenteditable="true"><p>Draft reply</p></div>`, "Draft reply")).toBe("***** *****");
    expect(recordedTextOf(`<div contenteditable="false"><p>Read only</p></div>`, "Read only")).toBe("Read only");
  });

  it("masks work content unless the page allows it", () => {
    const html = `<div class="${ANALYTICS_WORK_CONTENT_CLASS}"><p>Ship the Q3 plan</p></div>`;
    expect(recordedTextOf(html, "Ship the Q3 plan")).toBe("**** *** ** ****");
    document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
    try {
      expect(recordedTextOf(html, "Ship the Q3 plan")).toBe("Ship the Q3 plan");
      document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "pending");
      expect(recordedTextOf(html, "Ship the Q3 plan")).toBe("**** *** ** ****");
    } finally {
      document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
    }
  });

  it("keeps strict markers inside visible work content masked", () => {
    document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
    try {
      const work = (inner: string) => `<div class="${ANALYTICS_WORK_CONTENT_CLASS}"><p>Plan <span>${inner}</span></p></div>`;
      expect(recordedTextOf(work(`</span><span class="${ANALYTICS_MASK_CLASS}">ana@acme.com`), "ana@acme.com")).toBe("************");
      expect(recordedTextOf(work(`</span><span contenteditable="true">Draft`), "Draft")).toBe("*****");
      expect(recordedTextOf(`<div class="${ANALYTICS_WORK_CONTENT_CLASS} ${ANALYTICS_MASK_CLASS}"><p>Both markers</p></div>`, "Both markers")).toBe("**** *******");
      // A work row inside a masked container shows (the task chat description).
      expect(recordedTextOf(`<div class="${ANALYTICS_MASK_CLASS}"><div class="${ANALYTICS_WORK_CONTENT_CLASS}"><p>Brief</p></div><p>Reply</p></div>`, "Brief")).toBe("Brief");
      expect(recordedTextOf(`<div class="${ANALYTICS_MASK_CLASS}"><div class="${ANALYTICS_WORK_CONTENT_CLASS}"><p>Brief</p></div><p>Reply</p></div>`, "Reply")).toBe("*****");
    } finally {
      document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
    }
  });

  it("masks secrets inside visible work content", () => {
    document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
    try {
      const work = (text: string) => `<div class="${ANALYTICS_WORK_CONTENT_CLASS}"><pre>${text}</pre></div>`;
      expect(recordedTextOf(work("OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234"), "OPENAI_API_KEY="))
        .toBe(`OPENAI_API_KEY=${stars("sk-proj-abcdefghijklmnop1234")}`);
      expect(recordedTextOf(work("Deploy the Q3 plan"), "Deploy the Q3 plan")).toBe("Deploy the Q3 plan");
    } finally {
      document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
    }
  });

  it.each([
    ["an OpenAI key", "key sk-proj-abcdefghijklmnop1234 here", "sk-proj-abcdefghijklmnop1234"],
    ["an Anthropic key", "sk-ant-api03-AbCdEfGhIjKlMnOpQr", "sk-ant-api03-AbCdEfGhIjKlMnOpQr"],
    ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["a Slack token", "xoxb-123456789012-abcdefABCDEF", "xoxb-123456789012-abcdefABCDEF"],
    ["an AWS key id", "id AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["a Google API key", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh1234", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh1234"],
    ["an env assignment", "DATABASE_PASSWORD=hunter2", "hunter2"],
    ["a JSON field", "\"apiKey\": \"abc123secret\"", "abc123secret"],
    ["a YAML field", "client_secret: s3cr3t-value", "s3cr3t-value"],
    ["a quoted password with spaces", "password=\"correct horse battery staple\"", "correct horse battery staple"],
    ["a single-quoted secret with punctuation", "secret: 'p@ss, word; 42!'", "p@ss, word; 42!"],
    ["an unquoted YAML password with spaces", "password: correct horse battery staple", "correct horse battery staple"],
    ["a quoted value with an escaped quote", "\"token\": \"ab\\\"cd ef\"", "ab\\\"cd ef"],
    ["a bearer header", "Authorization: Bearer abcdef123456", "abcdef123456"],
    ["URL credentials", "postgres://admin:pa55word@db.internal:5432/app", "admin:pa55word"],
    ["a random token", "value Xk9pQ2mZ7rT4vB8nL3wY6sD1fH5jK0aC", "Xk9pQ2mZ7rT4vB8nL3wY6sD1fH5jK0aC"],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIBOg\n-----END RSA PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----\nMIIBOg\n-----END RSA PRIVATE KEY-----"],
  ])("redactReplaySecrets masks %s", (_label, input, secret) => {
    expect(redactReplaySecrets(input)).toBe(input.replace(secret, stars(secret)));
  });

  it("masks only the secret value in JSON, leaving the next field", () => {
    expect(redactReplaySecrets("{\"password\": \"correct horse\", \"title\": \"Q3 plan\"}"))
      .toBe("{\"password\": \"******* *****\", \"title\": \"Q3 plan\"}");
  });

  it("masks an unclosed quoted secret to the end of its line", () => {
    expect(redactReplaySecrets("password=\"correct horse\nnext line")).toBe("password=\"******* *****\nnext line");
  });

  it("masks a secret value longer than any length limit in full", () => {
    const hex = "0123456789abcdef".repeat(400);
    expect(redactReplaySecrets(`COOKIE=${hex}`)).toBe(`COOKIE=${stars(hex)}`);
    expect(redactReplaySecrets(`"cookie": "${hex}", "title": "Q3"`)).toBe(`"cookie": "${stars(hex)}", "title": "Q3"`);
  });

  it("masks secrets behind long names, after other assignments, and long URL passwords", () => {
    const longName = `${"SERVICE_".repeat(12)}PASSWORD`;
    expect(redactReplaySecrets(`${longName}=hunter2`)).toBe(`${longName}=*******`);
    expect(redactReplaySecrets("user=bob password=hunter2")).toBe("user=bob password=*******");
    const longPassword = "p".repeat(400);
    expect(redactReplaySecrets(`postgres://admin:${longPassword}@db:5432/app`))
      .toBe(`postgres://${stars(`admin:${longPassword}`)}@db:5432/app`);
    const longFlag = `--${"service-".repeat(500)}password`;
    expect(redactReplaySecrets(`${longFlag} hunter2 --region us`)).toBe(`${longFlag} ******* --region us`);
  });

  it.each([
    ["a spaced label", "API key: 8f3a9c2e41b7d605", "8f3a9c2e41b7d605"],
    ["a spaced label after other words", "The staging private key: 8f3a9c2e41b7d605", "8f3a9c2e41b7d605"],
    ["a session id label", "Session ID: 9f8e7d6c5b4a", "9f8e7d6c5b4a"],
    ["a name that ends in key", "ENCRYPTION_KEY=0f1e2d3c4b5a", "0f1e2d3c4b5a"],
    ["a camel-case key name", "signingKey: 'left right'", "left right"],
    ["a short password name", "DB_PASS=hunter2", "hunter2"],
    ["a PIN", "PIN: 4821", "4821"],
    ["a passphrase", "passphrase: correct horse", "correct horse"],
    ["a bold Markdown label in a raw file", "**Password**: hunter2", "hunter2"],
    ["a command-line flag", "mysql --password hunter2 --host db", "hunter2"],
    ["a quoted command-line flag", "deploy --api-key \"left right\" --region us", "\"left right\""],
    ["a quoted flag value with escaped quotes", "mysql --password \"correct \\\"horse\\\" battery staple\" --host db", "\"correct \\\"horse\\\" battery staple\""],
    ["a single-quoted flag value with an escaped quote", "run --token 'it\\'s a secret' --dry-run", "'it\\'s a secret'"],
    ["a flag name with an underscore", "run --verbose --db_password hunter2 --host db", "hunter2"],
  ])("redactReplaySecrets masks %s", (_label, input, secret) => {
    expect(redactReplaySecrets(input)).toBe(input.replace(secret, stars(secret)));
  });

  describe("a secret split across the nodes of one line", () => {
    // rrweb records one text node at a time. Markdown and syntax highlighting
    // put a label and its value in different nodes of the same line.
    const work = (inner: string) => `<div class="${ANALYTICS_WORK_CONTENT_CLASS}">${inner}</div>`;

    function withVisibleWorkContent(run: () => void) {
      document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
      try {
        run();
      } finally {
        document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
      }
    }

    it("masks a value after a bold label", () => withVisibleWorkContent(() => {
      expect(recordedTextOf(work("<p><strong>Password:</strong> hunter2</p>"), "hunter2")).toBe(" *******");
      expect(recordedTextOf(work("<p><strong>Password:</strong> hunter2</p>"), "Password")).toBe("Password:");
    }));

    it("masks a value in inline code after its label", () => withVisibleWorkContent(() => {
      expect(recordedTextOf(work("<p>Password: <code>hunter2</code></p>"), "hunter2")).toBe("*******");
      expect(recordedTextOf(work("<p><strong>API key</strong>: <code>8f3a9c2e41b7d605</code></p>"), "8f3a")).toBe("****************");
      expect(recordedTextOf(work("<ul><li>Staging token: <code>blue-green-42</code></li><li>Owner: <code>ana</code></li></ul>"), "blue-green")).toBe("*************");
      expect(recordedTextOf(work("<ul><li>Staging token: <code>blue-green-42</code></li><li>Owner: <code>ana</code></li></ul>"), "ana")).toBe("ana");
    }));

    it("masks a quoted value with formatting inside it, and shows the text after its closing quote", () => withVisibleWorkContent(() => {
      const html = work('<p>Password: "correct <strong>horse</strong> battery <em>staple</em>" and then sign in</p>');
      expect(recordedTextOf(html, "Password")).toBe('Password: "******* ');
      expect(recordedTextOf(html, "horse")).toBe("*****");
      expect(recordedTextOf(html, "battery")).toBe(" ******* ");
      expect(recordedTextOf(html, "staple")).toBe("******");
      expect(recordedTextOf(html, "and then sign in")).toBe('" and then sign in');
    }));

    it("shows the sentence after an inline assignment, and masks a later secret in it", () => withVisibleWorkContent(() => {
      const html = work("<p>Set <code>API_KEY=abc123</code> in the env file, then use password: hunter2</p>");
      expect(recordedTextOf(html, "API_KEY")).toBe("API_KEY=******");
      expect(recordedTextOf(html, "in the env file")).toBe(" in the env file, then use password: *******");
    }));

    it("masks a value whose label follows an inline assignment in an earlier node", () => withVisibleWorkContent(() => {
      // The first value ends with its inline code, so the scan reads on and
      // finds the label that sits between the two code elements.
      const html = work("<p>Set <code>API_KEY=abc123</code> and password: <code>hunter2</code> today</p>");
      expect(recordedTextOf(html, "hunter2")).toBe("*******");
      expect(recordedTextOf(html, "today")).toBe(" today");
      const quoted = work("<p>Use <code>token=\"abc123\"</code> with pin: <code>4821</code></p>");
      expect(recordedTextOf(quoted, "4821")).toBe("****");
    }));

    it("masks an unquoted value with formatting inside it, to the end of its line", () => withVisibleWorkContent(() => {
      const html = work("<p><strong>Password:</strong> correct <em>horse</em> battery<br>Next line</p>");
      expect(recordedTextOf(html, "correct")).toBe(" ******* ");
      expect(recordedTextOf(html, "horse")).toBe("*****");
      expect(recordedTextOf(html, "battery")).toBe(" *******");
      expect(recordedTextOf(html, "Next line")).toBe("Next line");
    }));

    it("masks a value split across syntax highlight spans", () => withVisibleWorkContent(() => {
      const env = work("<pre><code><span>PASSWORD</span>=abc<span>$def</span>\n<span>REGION</span>=us</code></pre>");
      expect(recordedTextOf(env, "=abc")).toBe("=***");
      expect(recordedTextOf(env, "$def")).toBe("****");
      expect(recordedTextOf(env, "=us")).toBe("=us");
      const json = work("<pre><code>{<span>\"password\"</span><span>:</span> <span>\"correct horse\"</span>, <span>\"title\"</span>: <span>\"Q3 plan\"</span>}</code></pre>");
      expect(recordedTextOf(json, "correct horse")).toBe("\"******* *****\"");
      expect(recordedTextOf(json, "Q3 plan")).toBe("\"Q3 plan\"");
    }));

    it("reads the label through the file viewer's line-number gutter", () => withVisibleWorkContent(() => {
      const line = work("<pre><div><span aria-hidden=\"true\">12</span><code><span>db_password</span>: <span>hunter2</span></code></div><div><span aria-hidden=\"true\">13</span><code>region: us</code></div></pre>");
      expect(recordedTextOf(line, "hunter2")).toBe("*******");
      expect(recordedTextOf(line, "region")).toBe("region: us");
    }));

    it("keeps a label on its own line or block", () => withVisibleWorkContent(() => {
      expect(recordedTextOf(work("<p>Reset the password:</p><p>Open the settings page</p>"), "Open")).toBe("Open the settings page");
      expect(recordedTextOf(work("<p>Reset the password:<br>Open the settings page</p>"), "Open")).toBe("Open the settings page");
      expect(recordedTextOf(work("<table><tr><td>Password</td><td>rotated weekly</td></tr></table>"), "rotated")).toBe("rotated weekly");
    }));

    it("masks every candidate when sibling nodes hold the same text", () => withVisibleWorkContent(() => {
      // rrweb passes the text and its parent, not the node, so the two
      // " abc " nodes cannot be told apart: one follows a secret label.
      const html = work("<p><b>Token:</b> abc <b>Owner:</b> abc </p>");
      document.body.innerHTML = html;
      const texts = Array.from(document.querySelector("p")!.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE) as Text[];
      expect(texts.map(recordedText)).toEqual([" *** ", " *** "]);
    }));

    it("never shows more with line context than without it", () => {
      // A gutter number glued to a key breaks the word boundary of the known
      // formats. The text is still redacted by itself.
      expect(redactReplaySecrets("sk-proj-abcdefghijklmnop1234", { before: "12", continues: () => true }))
        .toBe(stars("sk-proj-abcdefghijklmnop1234"));
      expect(redactReplaySecrets("password: hunter2", { before: "note: ", continues: () => false })).toBe("password: *******");
      expect(redactReplaySecrets("plain words", { before: "note: ", continues: () => false })).toBe("plain words");
    });

    it("masks every line of a private key that the file viewer renders line by line", () => withVisibleWorkContent(() => {
      // `FileContentViewer`: one <div> per line, a gutter number and a <code>.
      const lines = [
        "notes for the deploy", "-----BEGIN RSA PRIVATE KEY-----", "Proc-Type: 4,ENCRYPTED", "\u200b",
        "abcdefghijklmnop", "QRSTUVWX", "tail12==", "-----END RSA PRIVATE KEY-----", "done", "abcdefghijklmnop",
      ];
      document.body.innerHTML = work(`<pre>${lines.map((line, index) => `<div><span aria-hidden="true">${index + 1}</span><code>${line}</code></div>`).join("")}</pre>`);
      const recorded = Array.from(document.querySelectorAll("code")).map((code) => recordedText(code.firstChild as Text));
      expect(recorded).toEqual([
        "notes for the deploy", stars("-----BEGIN RSA PRIVATE KEY-----"), "Proc-Type: 4,ENCRYPTED", "\u200b",
        "****************", "********", "********", "-----END RSA PRIVATE KEY-----", "done", "abcdefghijklmnop",
      ]);
    }));

    it("masks a PGP private key block line by line", () => withVisibleWorkContent(() => {
      const lines = ["-----BEGIN PGP PRIVATE KEY BLOCK-----", "Version: 2", "\u200b", "abcdefghijkl", "=AbCd", "-----END PGP PRIVATE KEY BLOCK-----", "after"];
      document.body.innerHTML = work(`<pre>${lines.map((line) => `<div><code>${line}</code></div>`).join("")}</pre>`);
      const recorded = Array.from(document.querySelectorAll("code")).map((code) => recordedText(code.firstChild as Text));
      expect(recorded).toEqual([stars(lines[0]!), "Version: 2", "\u200b", "************", "*****", lines[5], "after"]);
    }));

    it("masks the rest of a private key that ends inside a later node", () => withVisibleWorkContent(() => {
      const html = work("<pre><code><span>-----BEGIN PRIVATE KEY-----\n</span><span>abcdefgh\n</span><span>ijkl==\n-----END PRIVATE KEY-----\nsafe words</span></code></pre>");
      expect(recordedTextOf(html, "abcdefgh")).toBe("********\n");
      expect(recordedTextOf(html, "ijkl")).toBe("******\n-----END PRIVATE KEY-----\nsafe words");
    }));

    // rrweb calls the mask function for every text node, so its work per node
    // must not grow with the page. A wall-clock bound depends on the machine,
    // so these count how often the function reads the text of a node: to scan
    // siblings again for every node it would have to read each of them again.
    function textReadsWhileRecording(html: string): { reads: number; nodes: number } {
      document.body.innerHTML = html;
      const texts: Text[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) texts.push(walker.currentNode as Text);
      const readData = Object.getOwnPropertyDescriptor(CharacterData.prototype, "data")!.get!;
      let reads = 0;
      const spy = vi.spyOn(CharacterData.prototype, "data", "get").mockImplementation(function (this: CharacterData) {
        reads += 1;
        return readData.call(this);
      });
      try {
        for (const node of texts) recordedText(node);
      } finally {
        spy.mockRestore();
      }
      return { reads, nodes: texts.length };
    }

    // The line context reads at most 64 earlier nodes for one node.
    const MAX_TEXT_READS_PER_NODE = 100;

    it("does linear work on a long paragraph of prose between inline elements", () => withVisibleWorkContent(() => {
      // Every text child of the <p> differs, so each one is its own candidate.
      const parts = Array.from({ length: 1_500 }, (_unused, index) => `prose number ${index} goes on <b>bold ${index}</b> `).join("");
      const { reads, nodes } = textReadsWhileRecording(work(`<p>${parts}</p>`));
      // 1,500 prose nodes, 1,500 bold nodes and the space after the last one.
      expect(nodes).toBe(3_001);
      expect(reads).toBeLessThan(nodes * MAX_TEXT_READS_PER_NODE);
    }));

    it("does linear work on a long highlighted line", () => withVisibleWorkContent(() => {
      const spans = Array.from({ length: 1_000 }, (_unused, index) => `<span>part${index}</span> `).join("");
      const { reads, nodes } = textReadsWhileRecording(work(`<pre><code>${spans}</code></pre>`));
      expect(nodes).toBe(2_000);
      expect(reads).toBeLessThan(nodes * MAX_TEXT_READS_PER_NODE);
    }));
  });

  it("redacts a large text node quickly", () => {
    // rrweb calls this for every recorded text node, so it must stay linear.
    const inputs = [
      "tokentoken".repeat(20_000),
      "a".repeat(200_000),
      "password_".repeat(20_000) + "=x",
      "https://" + "a:".repeat(50_000),
      ("const value = computeTotal(lineItems); // TODO token budget\n").repeat(3_000),
      "password=\"" + "\\a".repeat(100_000),
      "secret: " + "x".repeat(200_000),
    ];
    const started = performance.now();
    for (const input of inputs) redactReplaySecrets(input);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each([
    "Ship the Q3 launch plan by Friday",
    "commit 3f786850e387550fdab836ed7e6dc881de23001b",
    "id 123e4567-e89b-12d3-a456-426614174000",
    "The token budget was 4k per run.",
    "See https://github.com/paperclipai/paperclip/pull/22820",
    "Key findings: revenue grew 12% in Q3",
    "Pass rate: 98% across the suite",
    "Keyboard shortcut: Ctrl+K",
    "OAuth: enabled for every workspace",
    "Next step: run pnpm verify --full",
  ])("redactReplaySecrets leaves ordinary text alone: %s", (input) => {
    expect(redactReplaySecrets(input)).toBe(input);
  });

  it("shows a task preview as work content only for the selected company's own task", () => {
    // A preview loads a task by id, so it can belong to another company than
    // the one whose source check set the page's visible flag.
    expect(workContentClassForCompany("co-1", "co-1")).toBe(ANALYTICS_WORK_CONTENT_CLASS);
    expect(workContentClassForCompany("co-2", "co-1")).toBe(ANALYTICS_MASK_CLASS);
    expect(workContentClassForCompany(undefined, "co-1")).toBe(ANALYTICS_MASK_CLASS);
    expect(workContentClassForCompany("co-1", null)).toBe(ANALYTICS_MASK_CLASS);
    expect(workContentClassForCompany(null, null)).toBe(ANALYTICS_MASK_CLASS);
    const quicklook = readFileSync(join(UI_SRC, "components/IssueLinkQuicklook.tsx"), "utf8");
    expect(quicklook).toContain("workContentClassForCompany(issue.companyId, selectedCompanyId)");
  });

  it.each([
    ["glpat", "-", "AbCdEfGhIjKlMnOpQr12"],
    ["ghp", "_", "AbCdEfGhIjKlMnOpQr12"],
    ["sk-proj", "-", "AbCdEfGhIjKlMnOpQr12"],
  ])("masks a %s credential in the rendered task preview", (prefix, separator, value) => {
    const token = [prefix, value].join(separator);
    const company = vi.spyOn(CompanyContext, "useOptionalCompany").mockReturnValue({
      selectedCompanyId: "co-1",
    } as ReturnType<typeof CompanyContext.useOptionalCompany>);
    document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
    try {
      const html = renderTaskPreview(`Use **${token}** for the review.`);
      expect(recordedTextOf(html, value)).toBe(`Use ${stars(token)} for the review.`);
      expect(document.querySelector('[data-slot="task-preview-description"]')?.textContent)
        .toBe(`Use ${token} for the review.`);
    } finally {
      company.mockRestore();
      document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
    }
  });

  it("masks a cut task preview whose text holds a credential", () => {
    // The preview shows 177 characters. A credential that crosses that cut is
    // too short to match its format, so its first characters would record.
    const lead = "Please rotate the deploy credential for the staging cluster before the Friday release and tell the team in the channel when it is done so nobody is blocked on it. ";
    const company = vi.spyOn(CompanyContext, "useOptionalCompany").mockReturnValue({
      selectedCompanyId: "co-1",
    } as ReturnType<typeof CompanyContext.useOptionalCompany>);
    document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
    try {
      for (const token of ["ghp_abcdefghijklmnopqrstuvwxyz0123", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234", "Xk9pQ2mZ7rT4vB8nL3wY6sD1fH5jK0aCXk9pQ2mZ7rT4"]) {
        const html = renderTaskPreview(`${lead}${token} and confirm.`);
        const rendered = document.createElement("div");
        rendered.innerHTML = html;
        const shown = rendered.querySelector('[data-slot="task-preview-description"]')?.textContent ?? "";
        // The person sees the cut text, with the start of the credential.
        expect(shown.endsWith("...")).toBe(true);
        expect(shown).toContain(token.slice(0, 8));
        // The replay records none of it.
        expect(recordedTextOf(html, "Please rotate")).toBe(stars(shown));
      }
      // A cut preview with no credential still shows.
      const plain = renderTaskPreview(`${lead}${lead}`);
      expect(recordedTextOf(plain, "Please rotate")).toContain("Please rotate the deploy credential");
    } finally {
      company.mockRestore();
      document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
    }
  });

  it.each(["`", "*", "_", "["])("bounds %s runs before converting a task preview", (marker) => {
    const convert = MarkdownPlainText.markdownToPlainText;
    const conversion = vi.spyOn(MarkdownPlainText, "markdownToPlainText").mockImplementation((markdown) => {
      expect(markdown.length).toBeLessThanOrEqual(2_048);
      return convert(markdown);
    });
    const company = vi.spyOn(CompanyContext, "useOptionalCompany").mockReturnValue({
      selectedCompanyId: "co-1",
    } as ReturnType<typeof CompanyContext.useOptionalCompany>);
    document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
    try {
      const html = renderTaskPreview(`Use ${marker.repeat(128_000)}x`);
      const recorded = recordedTextOf(html, "Use");
      const rendered = document.querySelector('[data-slot="task-preview-description"]')?.textContent ?? "";
      expect(conversion).toHaveBeenCalledTimes(1);
      expect(rendered.length).toBeLessThanOrEqual(180);
      expect(rendered).toContain("Use");
      expect(recorded).toBe(stars(rendered));
    } finally {
      company.mockRestore();
      conversion.mockRestore();
      document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
    }
  });

  it("redacts an adversarial run of hyphens without stalling the recorder", () => {
    const prefix = "-".repeat(512 * 1024);
    const input = `${prefix}\nmysql --password hunter2 --host db`;
    const started = performance.now();
    expect(redactReplaySecrets(input)).toBe(`${prefix}\nmysql --password ******* --host db`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("sends the marker selector and the work content mask function to session replay", () => {
    expect(options.session_recording.maskTextSelector).toBe(ANALYTICS_MASK_TEXT_SELECTOR);
    expect(options.session_recording.maskTextFn).toBe(maskReplayText);
    expect(options.session_recording.maskAllInputs).toBe(true);
    expect(options.session_recording.blockClass).toBe(ANALYTICS_NO_CAPTURE_CLASS);
  });

  it("masks a voice transcript", () => {
    const html = renderToStaticMarkup(
      <VoiceTranscript agentName="Ada" entries={[{ id: "1", source: "user", text: "Read my latest Gmail", final: true, interrupted: false } as never]} />,
    );
    expect(recordedTextOf(html, "Read my latest Gmail")).toBe("**** ** ****** *****");
  });

  it("masks a tool result in a run transcript", () => {
    const html = renderToStaticMarkup(
      <RunTranscriptView
        mode="raw"
        entries={[{ kind: "tool_result", ts: "2026-01-01T00:00:00Z", toolUseId: "t1", toolName: "gmail_read", content: "Subject: Globex renewal", isError: false }]}
      />,
    );
    expect(recordedTextOf(html, "Globex renewal")).not.toMatch(/[A-Za-z]/);
  });

  it("masks the adapter command, prompt, context and environment of a run invocation", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <RunInvocationCard
        censorUsernameInLogs={false}
        payload={{
          adapterType: "claude_local",
          command: "claude",
          commandArgs: ["--append", "Reply to jane@globex.com"],
          commandNotes: ["Loaded Globex renewal notes"],
          prompt: "Summarize the Globex renewal thread",
          context: { inbox: "jane@globex.com" },
          env: { GLOBEX_ACCOUNT: "globex-tenant" },
        }}
      />,
    ));
    const details = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Details"));
    await act(async () => details!.click());
    expect(replayLeaks("Reply to jane@globex.com", host)).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Loaded Globex renewal notes", host)).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Summarize the Globex renewal thread", host)).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("jane@globex.com", host).recorded).toBe(false);
    expect(replayLeaks("globex-tenant", host)).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Prompt", host)).toEqual({ rendered: true, recorded: true });
    await act(async () => root.unmount());
    host.remove();
  });

  it("masks document revision diff lines inside the diff dialog portal", async () => {
    const revision = (revisionNumber: number, body: string) => ({
      id: `rev-${revisionNumber}`, companyId: "c", documentId: "d", issueId: "i", key: "plan", revisionNumber,
      title: "Plan", format: "markdown", body, changeSummary: null, createdByAgentId: null, createdByUserId: null,
      createdAt: "2026-01-01T00:00:00Z",
    }) as unknown as DocumentRevision;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <DocumentDiffModal
          documentKey="plan"
          latestRevisionNumber={2}
          open
          onOpenChange={() => {}}
          revisionsQueryKey={["diff-test"]}
          revisionsQueryFn={async () => [revision(1, "Call Globex about renewal"), revision(2, "Email jane@globex.com the renewal")]}
        />
      </QueryClientProvider>,
    ));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Email jane@globex.com the renewal"));
    expect(host.contains(document.querySelector('[role="dialog"]'))).toBe(false);
    expect(replayLeaks("Call Globex about renewal", document.body)).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Email jane@globex.com the renewal", document.body)).toEqual({ rendered: true, recorded: false });
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  it("blocks secret markers entirely instead of masking them", () => {
    document.body.innerHTML = `<p class="${ANALYTICS_NO_CAPTURE_CLASS}"><span>pcgw_live_123</span></p><p>Copy token</p>`;
    expect(isBlockedFromReplay("pcgw_live_123")).toBe(true);
    expect(isBlockedFromReplay("Copy token")).toBe(false);
  });

  it.each([
    { name: "a linked Slack conversation", provider: "slack" as const, externalUrl: "https://globex.slack.com/archives/C1", label: "#globex-deals" },
    { name: "an unlinked Slack conversation", provider: "slack" as const, externalUrl: null, label: "#globex-deals" },
    { name: "a linked GitHub thread", provider: "github" as const, externalUrl: "https://github.com/globex/renewals/issues/7", label: "globex/renewals #7" },
    { name: "an email conversation", provider: "agentmail" as const, externalUrl: null, label: "jane@globex.com" },
  ])("masks the destination of $name in the conversation list", ({ provider, externalUrl, label }) => {
    document.body.innerHTML = renderToStaticMarkup(
      <ChatConversationList provider={provider} rows={[{ id: "c1", externalLabel: label, externalUrl, state: "completed", updatedAt: "2026-01-01T00:00:00Z" }]} />,
    );
    expect(replayLeaks(label)).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Completed")).toEqual({ rendered: true, recorded: true });
  });

  it.each(MASKED_SURFACES)("keeps the source mask on $content in $file", ({ file, content }) => {
    const source = readFileSync(join(UI_SRC, file), "utf8");
    const index = source.indexOf(content);
    expect(index, `content not found in ${file}`).toBeGreaterThanOrEqual(0);
    const contentTag = source.startsWith("<", index) ? source.slice(index, tagEnd(source, index + 1) + 1) : "";
    const elements = [...openElementsAt(source, index), contentTag];
    expect(elements.some((tag) => tag.includes("ANALYTICS_MASK_CLASS"))).toBe(true);
  });

  it.each([
    { file: "components/FileViewerSheet.tsx", content: "<WorkspaceFileMarkdownBody" },
  ])("renders Markdown work content with the work marker at $content in $file", ({ file, content }) => {
    // An inner MarkdownBody without replayContent="work" carries the strict
    // mask, which wins over a work marker on its wrapper.
    const source = readFileSync(join(UI_SRC, file), "utf8");
    const index = source.indexOf(content);
    expect(index, `content not found in ${file}`).toBeGreaterThanOrEqual(0);
    expect(source.slice(index, tagEnd(source, index + 1) + 1)).toContain("replayContent=\"work\"");
  });

  it.each(WORK_CONTENT_SURFACES)("keeps the work content mask on $content in $file", ({ file, content }) => {
    const source = readFileSync(join(UI_SRC, file), "utf8");
    const index = source.indexOf(content);
    expect(index, `content not found in ${file}`).toBeGreaterThanOrEqual(0);
    const contentTag = source.startsWith("<", index) ? source.slice(index, tagEnd(source, index + 1) + 1) : "";
    const elements = [...openElementsAt(source, index), contentTag];
    // `workContentClassForCompany` picks the work marker for the selected company's own content.
    expect(elements.some((tag) => tag.includes("ANALYTICS_WORK_CONTENT_CLASS") || tag.includes("workContentClassForCompany("))).toBe(true);
  });

  it("finds the portaled content of connection and account surfaces", () => {
    expect(CONNECTION_PORTALS.length).toBeGreaterThan(40);
  });

  it.each(CONNECTION_PORTALS)("masks the portal at $file:$line", ({ tag }) => {
    expect(tag).toMatch(/ANALYTICS_MASK_CLASS|ANALYTICS_NO_CAPTURE_CLASS/);
  });

  it("masks the subscription account label in AccountQuotaPanels", () => {
    document.body.innerHTML = renderToStaticMarkup(<AccountQuotaPanels accounts={[{
      provider: "anthropic", accountKey: "key", accountLabel: "fenwick.oriel@example.test", ok: true,
      windows: [{ label: "Weekly limit", usedPercent: 40, valueLabel: null, resetsAt: null, detail: null }],
    }]} />);
    expect(replayLeaks("fenwick.oriel@example.test")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Weekly limit")).toEqual({ rendered: true, recorded: true });
  });

  it("blocks the webhook URL and secret in WebhookFields CopyField", () => {
    document.body.innerHTML = renderToStaticMarkup(<>
      <CopyField label="Webhook URL" value="https://paperclip.example.test/api/routine-triggers/hook_k4Zr9Qe1" />
      <CopyField label="Authentication key" value="whsec_Tq8vLm2Rz7Np" />
    </>);
    expect(isBlockedFromReplay("hook_k4Zr9Qe1", document.body)).toBe(true);
    expect(isBlockedFromReplay("whsec_Tq8vLm2Rz7Np", document.body)).toBe(true);
  });

  it("filters incompatible OpenRouter models and masks account labels in AiConnectionPicker", () => {
    document.body.innerHTML = renderToStaticMarkup(<AiConnectionPicker
      adapterType="opencode_local" model="zai/glm-5" requirement={{ companyId: "company", provider: "openrouter" }}
      connections={[{ id: "router", grantId: "grant", companyId: "company", provider: "openrouter", method: "api_key",
        name: "Shared router", ownership: "shared", status: "connected" }]}
      currentUserId="user" agentId="agent" agentName="Nova" onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(document.body.textContent).not.toContain("Shared router");
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Responsible user’s connection"]')!.disabled).toBe(true);
    expect(document.body.textContent).toContain("Incompatible with this harness and model");

    document.body.innerHTML = renderToStaticMarkup(<AiConnectionPicker
      requirement={{ companyId: "company", provider: "anthropic" }}
      connections={[{ id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "api_key",
        name: "Shared Claude key", accountLabel: "orla.brisk@example.test", ownership: "shared", status: "connected" }]}
      currentUserId="user" agentId="agent" agentName="Nova" onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(replayLeaks("orla.brisk@example.test")).toEqual({ rendered: true, recorded: false });

    document.body.innerHTML = renderToStaticMarkup(<AiConnectionPicker
      requirement={{ companyId: "company", provider: "anthropic" }}
      connections={[{ id: "mine", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
        name: "Orla's Claude Max", ownership: "personal", ownerUserId: "user", isDefault: true, status: "connected" }]}
      currentUserId="user" agentId="agent" agentName="Nova" onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(replayLeaks("Orla's Claude Max")).toEqual({ rendered: true, recorded: false });
  });

  it("masks account labels in AiConnectionAccountControls, AiConnectionIdentity, and AiConnectionPoolRunDetails", () => {
    document.body.innerHTML = renderToStaticMarkup(<AiConnectionAccountControls
      account={{ id: "connection", grantId: "grant", companyId: "company", provider: "openai", method: "subscription",
        name: "Team ChatGPT", accountLabel: "tamsin.vale@example.test", ownership: "shared", status: "connected" }}
      grant={{ id: "grant", capabilities: { canRevoke: true, canEditAudience: false } } as ConnectionGrant}
      currentUserId="user" onMakeDefault={vi.fn()} onReconnect={vi.fn()} onRevoke={vi.fn()} />);
    expect(replayLeaks("tamsin.vale@example.test")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Reconnect")).toEqual({ rendered: true, recorded: true });

    document.body.innerHTML = renderToStaticMarkup(<AiConnectionIdentity connection={{
      id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
      name: "Zephyr Labs Claude", accountLabel: "quill.marten@example.test", ownership: "shared", status: "connected",
    }} />);
    expect(replayLeaks("Zephyr Labs Claude")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("quill.marten@example.test")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Company shared")).toEqual({ rendered: true, recorded: true });

    document.body.innerHTML = renderToStaticMarkup(<AiConnectionPoolRunDetails context={{
      aiRouterSelection: { binding: { provider: "anthropic" }, runtimeConfig: { model: "claude-sonnet" }, notes: [] },
      aiConnection: { accountName: "Juniper Ops Pool Account", connectionId: "connection" },
    }} />);
    expect(replayLeaks("Juniper Ops Pool Account")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("claude-sonnet")).toEqual({ rendered: true, recorded: true });
  });

  it("blocks the setup prompt preview carrying pairing tokens in AgentSetupPrompt", async () => {
    const prevMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      const prompt = "Run: paperclipai pair --token pcp_pair_8f3kQz2LmWv";
      await act(async () => root.render(<AgentSetupPrompt prompt={prompt} />));
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      expect(document.querySelector("pre[aria-label='Setup prompt']")).not.toBeNull();
      expect(isBlockedFromReplay("pcp_pair_8f3kQz2LmWv", document.body)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      window.matchMedia = prevMatchMedia;
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("never lets autocapture record element text or attribute values", () => {
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
  });
});

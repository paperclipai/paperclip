// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentRevision } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentDiffModal } from "@/components/DocumentDiffModal";
import { RunInvocationCard } from "@/components/run-log/RunDetails";
import { ChatConversationList } from "@/pages/apps/chat/ChatConversationList";
import { VoiceTranscript } from "@/components/voice/VoiceTranscript";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { buildPostHogInitOptions } from "./product-analytics";
import { ANALYTICS_MASK_CLASS, ANALYTICS_MASK_TEXT_SELECTOR, ANALYTICS_NO_CAPTURE_CLASS } from "./privacy";
import { isBlockedFromReplay, replayLeaks } from "./replay-recording.test-utils";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const UI_SRC = join(import.meta.dirname, "../..");

const options = buildPostHogInitOptions(
  { token: "t", apiHost: "/_ph", uiHost: null, environment: "production", stackId: "s", replayEnabled: true },
  "acme.paperclip.app",
);

function recordedText(node: Text): string {
  const parent = node.parentElement;
  const masked = parent?.closest(options.session_recording.maskTextSelector) != null;
  return masked ? node.data.replace(/\S/g, "*") : node.data;
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

const MASKED_SURFACES: Array<{ file: string; content: string }> = [
  { file: "components/LinkPreview.tsx", content: "{preview.title}" },
  { file: "components/LinkPreview.tsx", content: "{target.canonicalUrl}" },
  { file: "components/IssueLinkQuicklook.tsx", content: "data-slot=\"task-preview-description\"" },
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
  { file: "components/task-side-panel/TaskAttachmentPanel.tsx", content: "File is empty." },
  { file: "components/artifacts/ArtifactCard.tsx", content: "{preview}" },
  { file: "components/artifacts/RichArtifactCards.tsx", content: "<PatchLines text={body} />" },
  { file: "components/artifacts/RichArtifactCards.tsx", content: "<ReactMarkdown" },
  { file: "components/artifacts/RichArtifactCards.tsx", content: "{columns.map(" },
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

  it("sends only the marker selector to session replay", () => {
    expect(options.session_recording.maskTextSelector).toBe(ANALYTICS_MASK_TEXT_SELECTOR);
    expect(options.session_recording).not.toHaveProperty("maskTextFn");
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

  it("finds the portaled content of connection and account surfaces", () => {
    expect(CONNECTION_PORTALS.length).toBeGreaterThan(40);
  });

  it.each(CONNECTION_PORTALS)("masks the portal at $file:$line", ({ tag }) => {
    expect(tag).toMatch(/ANALYTICS_MASK_CLASS|ANALYTICS_NO_CAPTURE_CLASS/);
  });

  it("never lets autocapture record element text or attribute values", () => {
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
  });
});

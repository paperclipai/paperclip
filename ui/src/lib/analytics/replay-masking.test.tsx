// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceTranscript } from "@/components/voice/VoiceTranscript";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { buildPostHogInitOptions } from "./product-analytics";
import { ANALYTICS_MASK_CLASS, ANALYTICS_MASK_TEXT_SELECTOR, ANALYTICS_NO_CAPTURE_CLASS } from "./privacy";

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
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", content: "@{github.login}" },
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

  it.each(MASKED_SURFACES)("masks $content in $file", ({ file, content }) => {
    const source = readFileSync(join(UI_SRC, file), "utf8");
    const index = source.indexOf(content);
    expect(index, `content not found in ${file}`).toBeGreaterThanOrEqual(0);
    const contentTag = source.startsWith("<", index) ? source.slice(index, tagEnd(source, index + 1) + 1) : "";
    const elements = [...openElementsAt(source, index), contentTag];
    expect(elements.some((tag) => tag.includes("ANALYTICS_MASK_CLASS"))).toBe(true);
  });

  it("never lets autocapture record element text or attribute values", () => {
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
  });
});

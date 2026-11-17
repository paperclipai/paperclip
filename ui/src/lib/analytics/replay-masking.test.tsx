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

const MASKED_SURFACES: Array<{ file: string; marker: string }> = [
  { file: "components/LinkPreview.tsx", marker: "data-link-preview-state={state}" },
  { file: "components/IssueLinkQuicklook.tsx", marker: "data-slot=\"task-preview-description\"" },
  { file: "components/ExternalObjectPill.tsx", marker: "{valueLabel}</span>" },
  { file: "components/issue-properties/external-object-rows.tsx", marker: "{displayKey}</span>" },
  { file: "components/issue-properties/external-object-rows.tsx", marker: "{value}</span>" },
  { file: "components/IssueRelatedWorkPanel.tsx", marker: "{pill.displayTitle}" },
  { file: "components/EmailMessageCard.tsx", marker: "task-context-notice space-y-3\" : \"space-y-4 rounded-xl" },
  { file: "components/EmailTaskActivity.tsx", marker: "aria-label=\"Email send intent\"" },
  { file: "pages/apps/Browse.tsx", marker: "block max-w-full cursor-pointer truncate" },
  { file: "pages/apps/Browse.tsx", marker: "max-w-full truncate hover:underline" },
  { file: "pages/apps/Connections.tsx", marker: "{row.displayName}</span>" },
  { file: "pages/apps/AppDetail.tsx", marker: "text-xl font-semibold" },
  { file: "pages/apps/AppDetail.tsx", marker: "truncate text-xl font-bold" },
  { file: "components/AppConnectionSidebar.tsx", marker: "{appName}</span>" },
  { file: "features/connections/ConnectionChoiceList.tsx", marker: "{choice.name}</span>" },
  { file: "features/connections/ConnectionIntentInteractionBody.tsx", marker: "access to “{accessRequest.connectionName}”" },
  { file: "features/connections/ConnectionIntentInteractionBody.tsx", marker: "{repair.connection.name} is ready." },
  { file: "features/connections/ConnectionIntentInteractionBody.tsx", marker: "must reconnect ${repair.connection.name}" },
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", marker: "github.com/${encodeURIComponent(github.login)}" },
  { file: "pages/apps/app-detail/IdentitiesSection.tsx", marker: "aria-label=\"Accessible GitHub repositories\"" },
  { file: "pages/apps/chat/slack/ManagedSlackSetup.tsx", marker: "{workspaces[0]!.workspaceName}" },
  { file: "pages/apps/chat/slack/ManagedSlackSetup.tsx", marker: "<SelectContent className={ANALYTICS_MASK_CLASS}>" },
  { file: "pages/apps/chat/ChatEndpointDetail.tsx", marker: "\"min-w-0 flex-1\", ANALYTICS_MASK_CLASS" },
  { file: "pages/apps/chat/ChatConversationList.tsx", marker: "{row.externalLabel}</span>" },
  { file: "components/voice/SpekoCallHistory.tsx", marker: "aria-label=\"Call transcript\"" },
  { file: "pages/CaseDetail.tsx", marker: "{caseData.summary}</p>" },
  { file: "components/CaseFieldsPanel.tsx", marker: "aria-label=\"Case fields\"" },
  { file: "components/task-side-panel/TaskAttachmentPanel.tsx", marker: "renderHtml || renderCsv ?" },
  { file: "components/artifacts/ArtifactCard.tsx", marker: "whitespace-pre-wrap break-words text-base" },
  { file: "components/artifacts/RichArtifactCards.tsx", marker: "<table className" },
  { file: "components/artifacts/RichArtifactCards.tsx", marker: "function Markdown(" },
  { file: "components/artifacts/RichArtifactCards.tsx", marker: "paperclip-patch-preview m-0" },
  { file: "components/AttentionQueueRow.tsx", marker: "{detailLine}</p>" },
  { file: "components/AttentionQueueRow.tsx", marker: "title={item.subject.title ?? undefined}" },
  { file: "components/AttentionObligationEvidence.tsx", marker: "data-attention-evidence={entry.id}" },
  { file: "components/coordinator/NeedsYouCardKit.tsx", marker: "data-needs-you-note" },
  { file: "components/coordinator/NeedsYouCardParts.tsx", marker: "{receipt.reason}</p>" },
  { file: "components/coordinator/CoordinatorDecisionReceipt.tsx", marker: "data-decision-history-reason" },
  { file: "components/coordinator/CoordinatorNeedsYou.tsx", marker: "<h2>{title}</h2>" },
  { file: "components/DecisionCard.tsx", marker: "{option.description}</div>" },
  { file: "components/DecisionCard.tsx", marker: "{row.summary}</span>" },
  { file: "components/IssueThreadInteractionCard.tsx", marker: "<SuggestTasksCard" },
  { file: "components/IssueThreadInteractionCard.tsx", marker: "<ConnectionIntentInteractionBody" },
  { file: "components/IssueThreadInteractionCard.tsx", marker: "data-presentation={presentationVariant}" },
  { file: "components/IssueRecoveryActionCard.tsx", marker: "{headline}</p>" },
  { file: "components/IssueRecoveryActionCard.tsx", marker: "{evidenceSummary.text}</span>" },
  { file: "components/IssueRunLedger.tsx", marker: "{retryState.detail}</p>" },
  { file: "components/ToastViewport.tsx", marker: "mt-1 text-xs leading-4 opacity-70" },
  { file: "components/interrupt-handoff/InterruptHandoffViews.tsx", marker: "{preview.text}</span>" },
  { file: "components/interrupt-handoff/InterruptHandoffViews.tsx", marker: "{bucket.detail}</span>" },
  { file: "components/ApprovalPayload.tsx", marker: "{String(value)}</span>" },
  { file: "components/ApprovalPayload.tsx", marker: "{String(payload.guidance)}</p>" },
  { file: "components/ApprovalPayload.tsx", marker: "max-h-48 overflow-auto rounded-lg" },
  { file: "components/actions/ActionCard.tsx", marker: "leading-relaxed text-foreground" },
  { file: "components/run-log/LogViewer.tsx", marker: "font-mono text-xs space-y-0.5" },
  { file: "components/run-log/LogViewer.tsx", marker: "bg-red-50 dark:bg-red-950/20 p-3 space-y-2" },
  { file: "components/search/SearchResultRow.tsx", marker: "\"line-clamp-1 truncate\"" },
];

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

  it.each(MASKED_SURFACES)("masks connected-account content in $file at $marker", ({ file, marker }) => {
    const source = readFileSync(join(UI_SRC, file), "utf8");
    const index = source.indexOf(marker);
    expect(index, `marker not found in ${file}`).toBeGreaterThanOrEqual(0);
    expect(source.slice(Math.max(0, index - 300), index + marker.length + 300)).toContain("ANALYTICS_MASK_CLASS");
  });

  it("never lets autocapture record element text or attribute values", () => {
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
  });
});

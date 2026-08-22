import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionItemSnapshot } from "../reducer/session-reducer.js";
import type { TranscriptEntry } from "../browser/transcript-model.js";
import { Composer } from "./components/composer.js";
import { Conversation } from "./components/conversation.js";
import { RequestCard } from "./request-card.js";
import { SessionTimeline } from "./session-timeline.js";

const item: SessionItemSnapshot = {
  itemId: "assistant-1",
  kind: "agentMessage",
  status: "completed",
  text: "Canonical answer",
};

const entries: TranscriptEntry[] = [
  {
    kind: "item",
    key: "item:assistant-1",
    position: 1,
    role: "assistant",
    item,
    interrupted: false,
    streaming: false,
    toolName: null,
    input: null,
    output: null,
    failure: null,
  },
];

describe("public React contracts", () => {
  it("renders reducer-backed transcript semantics and the item renderer seam", () => {
    const html = renderToStaticMarkup(
      <Conversation entries={entries} renderItemBody={(entry) => <mark>{entry.text}</mark>} />,
    );
    expect(html).toContain('data-slot="conversation"');
    expect(html).toContain('role="log"');
    expect(html).toContain('class="pcr-message"');
    expect(html).toContain("<mark>Canonical answer</mark>");
  });

  it("keeps request status controls around the request-detail renderer", () => {
    const request = {
      kind: "request" as const,
      key: "request:r1",
      position: 2,
      requestId: "r1",
      requestKind: "command_approval",
      type: "approval",
      prompt: "Run command?",
      status: "pending" as const,
      actions: ["accept", "decline"],
      details: { command: "printf safe" },
      resolvedAction: null,
      resolvedAt: null,
      turnId: "turn-1",
    };
    const html = renderToStaticMarkup(
      <ol><RequestCard request={request} onResolve={() => undefined} renderRequestDetail={() => <code>custom detail</code>} /></ol>,
    );
    expect(html).toContain('data-slot="request-card"');
    expect(html).toContain("custom detail");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("exposes composer slots and canonical session timeline without a parallel model", () => {
    const composer = renderToStaticMarkup(
      <Composer state="idle" value="hello" onValueChange={() => undefined} onSubmit={() => undefined} onStop={() => undefined} leadingActions={<span>leading</span>} trailingActions={<span>trailing</span>} />,
    );
    const timeline = renderToStaticMarkup(<SessionTimeline snapshot={null} state={null} />);
    expect(composer).toContain('data-slot="composer"');
    expect(composer).toContain("leading");
    expect(composer).toContain("trailing");
    expect(timeline).toContain('data-slot="session-timeline"');
  });

  it("keeps exact failed-item diagnostics in the rendered record", () => {
    const failedEntries: TranscriptEntry[] = [{
      ...entries[0]!,
      item: { ...item, status: "failed", text: "Partial output" },
      failure: "exact upstream diagnostic",
    }];
    const html = renderToStaticMarkup(<Conversation entries={failedEntries} />);
    expect(html).toContain('data-testid="item-failure"');
    expect(html).toContain("exact upstream diagnostic");
  });
});

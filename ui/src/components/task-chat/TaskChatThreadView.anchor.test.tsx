// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <p>{children}</p>,
}));
vi.mock("@/context/ThemeContext", () => ({
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useNavigate: () => () => {},
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));
vi.mock("@/api/agentAvatar", () => ({}));

import { TaskChatThreadView } from "./TaskChatThreadView";
import type { TaskChatItem, TaskChatMessageItem } from "./task-chat-model";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function message(id: string, text: string): TaskChatMessageItem {
  return { id, kind: "message", author: "human", text };
}

function placeholder(runId: string): TaskChatItem {
  return {
    id: `${runId}:transcript-placeholder`,
    kind: "transcript_placeholder",
    runId,
    state: "loading",
  };
}

function errorRow(runId: string): TaskChatItem {
  return {
    id: `${runId}:transcript-placeholder`,
    kind: "transcript_placeholder",
    runId,
    state: "error",
  };
}

function resolvedTurn(runId: string): TaskChatItem {
  return {
    id: `${runId}:turn`,
    kind: "turn",
    settled: true,
    items: [],
    summary: { toolCount: 0, added: 0, removed: 0 },
  };
}

function render(items: TaskChatItem[]) {
  flushSync(() =>
    root.render(<TaskChatThreadView items={items} scroll={false} />),
  );
}

function anchors(): string[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>("[data-thread-anchor]"),
  ).map((node) => node.dataset.threadAnchor!);
}

it("gives a transcript placeholder the anchor of the turn that replaces it", () => {
  // The scroll holder holds the reading position by matching this attribute.
  // A placeholder and the turn it resolves into are one logical row, so they
  // have to share the anchor: the holder remembers whatever was under the
  // reader's eye, and a row that swaps its id leaves nothing to correct.
  render([placeholder("run-1"), message("m1", "above")]);
  const whileLoading = anchors();

  render([resolvedTurn("run-1"), message("m1", "above")]);
  const whenResolved = anchors();

  // Every anchor is stable across the swap, and the placeholder's own id is
  // not among them: that id is what made the anchor break.
  expect(whileLoading).toEqual(whenResolved);
  expect(whileLoading).not.toContain("run-1:transcript-placeholder");
  expect(whileLoading[0]).toBe("run-1:turn");
});

it("keeps distinct runs on distinct anchors", () => {
  // The shared anchor is per run, so two pending runs must not collapse onto
  // one another or the holder could correct against the wrong row.
  render([placeholder("run-1"), placeholder("run-2"), message("m1", "above")]);
  const rows = anchors();

  expect(rows[0]).toBe("run-1:turn");
  expect(rows[1]).toBe("run-2:turn");
  expect(new Set(rows).size).toBe(rows.length);
});

it("leaves message anchors on their own render key", () => {
  // A message can carry a renderKey so an optimistic echo keeps its identity;
  // that must keep winning over the id, or optimistic rows would lose their
  // anchor.
  const withKey: TaskChatMessageItem = { ...message("m1", "hi"), renderKey: "optimistic-m1" };
  render([withKey, placeholder("run-1")]);

  expect(anchors()[0]).toBe("optimistic-m1");
});

it("gives an error row its own anchor next to the turn it does not replace", () => {
  // A run with partial entries and a failed later read renders the settled turn
  // AND the error row, at the same chronological position. The error row is not
  // replaced by the turn, so it must not borrow the turn's anchor: two rows on
  // one anchor means React can reconcile the wrong one and the scroll holder can
  // correct against the wrong position.
  render([resolvedTurn("run-1"), errorRow("run-1"), message("m1", "below")]);

  const rows = anchors();
  expect(rows.filter((anchor) => anchor === "run-1:turn")).toHaveLength(1);
  expect(new Set(rows).size).toBe(rows.length);
  expect(rows).toContain("run-1:transcript-placeholder");
});

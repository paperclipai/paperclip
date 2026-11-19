// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $getSelection, $isRangeSelection, getNearestEditorFromDOMNode } from "lexical";
import { buildSkillMentionHref } from "@paperclipai/shared";
import { MarkdownEditor, type MentionOption } from "./MarkdownEditor";
import type { SlashCommandOption } from "../context/EditorAutocompleteContext";

const mentions: MentionOption[] = [
  { id: "agent:ada", kind: "agent", agentId: "ada", name: "Ada" },
  { id: "user:pat", kind: "user", userId: "pat", name: "Pat" },
  { id: "project:paperclip", kind: "project", projectId: "paperclip", name: "Paperclip" },
  { id: "issue:task", kind: "issue", issueIdentifier: "TST-123", name: "TST-123 Example task" },
];

const commands: SlashCommandOption[] = [
  {
    id: "skill:deploy", kind: "skill", skillId: "deploy", key: "deploy", name: "Deploy",
    slug: "deploy", description: null, href: buildSkillMentionHref("deploy", "deploy"), aliases: ["deploy"],
  },
  {
    id: "routine:nightly", kind: "routine", routineId: "nightly", name: "Nightly",
    status: "active", href: "routine://nightly", aliases: ["routine:Nightly"],
  },
  { id: "action:goal", kind: "action", command: "goal", name: "Goal", description: "Set a goal", aliases: ["goal"] },
];

describe("MarkdownEditor autocomplete separators", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalRangeRect: typeof Range.prototype.getBoundingClientRect;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    originalRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 10, 20);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Range.prototype.getBoundingClientRect = originalRangeRect;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["skill", "/dep", "/deploy", true, ""],
    ["routine", "/routine:Nigh", "/routine:Nightly", true, ""],
    ["action", "/go", "/goal", false, ""],
    ["agent", "@Ada", "@Ada", true, ""],
    ["user", "@Pat", "@Pat", true, ""],
    ["project", "@Paper", "@Paperclip", true, ""],
    ["task", "@TST", "TST-123", true, ""],
    ["project after a typed space", "@Paperclip", "@Paperclip", true, " "],
    ["routine after typed spaces", "/routine:Nightly", "/routine:Nightly", true, "  "],
  ])("keeps a space after a completed %s and types outside its link", async (_kind, value, completion, linked, typedSuffix) => {
    const onChange = vi.fn();
    function ControlledEditor() {
      const [markdown, setMarkdown] = useState(value);
      return <MarkdownEditor value={markdown} onChange={(next) => {
        onChange(next);
        setMarkdown(next);
      }} actionCommands={commands} mentions={mentions} />;
    }
    await act(async () => {
      root.render(<ControlledEditor />);
    });

    const editable = container.querySelector<HTMLElement>('[contenteditable="true"]')!;
    expect(editable).not.toBeNull();
    await act(async () => {
      editable.focus();
      const range = document.createRange();
      range.selectNodeContents(editable.querySelector('[data-lexical-text="true"]')!.firstChild!);
      range.collapse(false);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    if (typedSuffix) {
      const editor = getNearestEditorFromDOMNode(editable)!;
      await act(async () => {
        editor.update(() => {
          const selection = $getSelection();
          expect($isRangeSelection(selection)).toBe(true);
          if ($isRangeSelection(selection)) selection.insertText(typedSuffix);
        });
      });
      await act(async () => document.dispatchEvent(new Event("selectionchange")));
    }
    await vi.waitFor(() => expect(document.querySelector('[data-testid="mention-autocomplete-menu"]')).not.toBeNull());

    await act(async () => {
      editable.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => {
      expect(editable.textContent).toBe(`${completion} `);
      expect(editable.querySelector("a")?.textContent ?? null).toBe(linked ? completion : null);
      const caretPrefix = document.createRange();
      caretPrefix.selectNodeContents(editable);
      const selection = window.getSelection()!;
      caretPrefix.setEnd(selection.anchorNode!, selection.anchorOffset);
      expect(caretPrefix.toString()).toBe(`${completion} `);
    });
    expect(onChange.mock.lastCall?.[0]).toMatch(/ $/);
    expect(onChange.mock.lastCall?.[0]).not.toContain("\u00a0");
    expect(document.querySelector('[data-testid="mention-autocomplete-menu"]')).toBeNull();

    const editor = getNearestEditorFromDOMNode(editable)!;
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      editor.update(() => {
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        if ($isRangeSelection(selection)) selection.insertText("next");
      });
    });
    expect(editable.textContent).toBe(`${completion} next`);
    expect(editable.querySelector("a")?.textContent ?? null).toBe(linked ? completion : null);
    expect(onChange.mock.lastCall?.[0]).toMatch(/ next$/);
    expect(onChange.mock.lastCall?.[0]).not.toContain("\u00a0");
  });
});

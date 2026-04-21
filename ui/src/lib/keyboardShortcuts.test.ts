// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  findPageSearchShortcutTarget,
  focusPageSearchShortcutTarget,
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveIssueDetailGoKeyAction,
  resolveInboxQuickArchiveKeyAction,
  resolveInboxUndoArchiveKeyAction,
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "./keyboardShortcuts";

describe("keyboardShortcuts helpers", () => {
  it("detects editable shortcut targets", () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div contenteditable="true"><span id="contenteditable-child">Editable</span></div>
      <div role="textbox"><span id="textbox-child">Textbox</span></div>
      <button id="button">Action</button>
    `;

    const editableChild = wrapper.querySelector("#contenteditable-child");
    const textboxChild = wrapper.querySelector("#textbox-child");
    const button = wrapper.querySelector("#button");

    expect(isKeyboardShortcutTextInputTarget(editableChild)).toBe(true);
    expect(isKeyboardShortcutTextInputTarget(textboxChild)).toBe(true);
    expect(isKeyboardShortcutTextInputTarget(button)).toBe(false);
  });

  it("reports when a modal dialog is open", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div role="dialog" aria-modal="true"></div>`;

    expect(hasBlockingShortcutDialog(root)).toBe(true);
    expect(hasBlockingShortcutDialog(document.createElement("div"))).toBe(false);
  });

  it("ignores non-dialog elements that happen to be aria-modal", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section aria-modal="true"></section>`;

    expect(hasBlockingShortcutDialog(root)).toBe(false);
  });

  it("finds the visible page search shortcut target", () => {
    const root = document.createElement("div");
    const hidden = document.createElement("input");
    hidden.setAttribute("data-page-search-target", "true");
    vi.spyOn(hidden, "getClientRects").mockReturnValue([] as unknown as DOMRectList);

    const visible = document.createElement("input");
    visible.setAttribute("data-page-search-target", "true");
    vi.spyOn(visible, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);

    root.append(hidden, visible);
    document.body.appendChild(root);

    expect(findPageSearchShortcutTarget(root)).toBe(visible);

    root.remove();
  });

  it("focuses and selects the page search shortcut target", () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.value = "existing query";
    input.setAttribute("data-page-search-target", "true");
    vi.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    root.appendChild(input);
    document.body.appendChild(root);

    expect(focusPageSearchShortcutTarget(root)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    root.remove();
  });

  it("blurs page search on a plain Enter press", () => {
    expect(shouldBlurPageSearchOnEnter({
      key: "Enter",
      isComposing: false,
    })).toBe(true);
  });

  it("keeps focus while composing with an IME", () => {
    expect(shouldBlurPageSearchOnEnter({
      key: "Enter",
      isComposing: true,
    })).toBe(false);
  });

  it("blurs page search on Escape when the field is already empty", () => {
    expect(shouldBlurPageSearchOnEscape({
      key: "Escape",
      isComposing: false,
      currentValue: "",
    })).toBe(true);
  });

  it("keeps focus on the first Escape while the field still has text", () => {
    expect(shouldBlurPageSearchOnEscape({
      key: "Escape",
      isComposing: false,
      currentValue: "query",
    })).toBe(false);
  });

  it("archives only the first clean y press", () => {
    const button = document.createElement("button");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "y",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("archive");
  });

  it("ignores non-y keypresses", () => {
    const button = document.createElement("button");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "n",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("stays inert for modifier combos before a real keypress", () => {
    const button = document.createElement("button");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "Meta",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "y",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("ignores input typing instead of archiving", () => {
    const input = document.createElement("input");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "y",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: input,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("undoes only a clean lowercase u press when an archive is available", () => {
    const button = document.createElement("button");

    expect(resolveInboxUndoArchiveKeyAction({
      hasUndoableArchive: true,
      defaultPrevented: false,
      key: "u",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("undo_archive");
  });

  it("keeps uppercase U available for mark-unread handling", () => {
    const button = document.createElement("button");

    expect(resolveInboxUndoArchiveKeyAction({
      hasUndoableArchive: true,
      defaultPrevented: false,
      key: "U",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("arms go-to-inbox on a clean g press", () => {
    const button = document.createElement("button");

    expect(resolveIssueDetailGoKeyAction({
      armed: false,
      defaultPrevented: false,
      key: "g",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("arm");
  });

  it("navigates to inbox on i after g", () => {
    const button = document.createElement("button");

    expect(resolveIssueDetailGoKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "i",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("navigate_inbox");
  });

  it("focuses the comment composer on c after g", () => {
    const button = document.createElement("button");

    expect(resolveIssueDetailGoKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "c",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("focus_comment");
  });

  it("disarms go-to-inbox instead of firing from an editor", () => {
    const input = document.createElement("textarea");

    expect(resolveIssueDetailGoKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "i",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: input,
      hasOpenDialog: false,
    })).toBe("disarm");
  });
});

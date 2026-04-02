// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveInboxQuickArchiveKeyAction,
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

  it("disarms on the first non-y keypress", () => {
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
    })).toBe("disarm");
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

  it("disarms instead of archiving when typing into an editor", () => {
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
    })).toBe("disarm");
  });
});

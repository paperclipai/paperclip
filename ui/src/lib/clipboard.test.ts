// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

describe("copyTextToClipboard", () => {
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;
  const originalIsSecureContext = window.isSecureContext;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    document.execCommand = originalExecCommand;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: originalIsSecureContext,
    });
    vi.restoreAllMocks();
  });

  describe("secure context with native Clipboard API", () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        value: true,
      });
    });

    it("uses navigator.clipboard.writeText", async () => {
      await copyTextToClipboard("hello");
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("hello");
    });

    it("does not mount any DOM nodes", async () => {
      const before = document.body.children.length;
      await copyTextToClipboard("hello");
      expect(document.body.children.length).toBe(before);
    });

    it("falls back to execCommand when the native API rejects", async () => {
      writeText.mockReturnValueOnce(Promise.reject(new Error("transient NotAllowedError")));
      const execCommand = vi.fn(() => true);
      document.execCommand = execCommand as typeof document.execCommand;
      await copyTextToClipboard("cascaded");
      expect(writeText).toHaveBeenCalledWith("cascaded");
      expect(execCommand).toHaveBeenCalledWith("copy");
    });

    it("rejects when both the native API and the fallback fail", async () => {
      writeText.mockReturnValueOnce(Promise.reject(new Error("native denied")));
      const execCommand = vi.fn(() => false);
      document.execCommand = execCommand as typeof document.execCommand;
      await expect(copyTextToClipboard("both fail")).rejects.toThrow(/execCommand/);
      expect(execCommand).toHaveBeenCalled();
    });
  });

  describe("non-secure context fallback", () => {
    let execCommand: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        value: false,
      });
      execCommand = vi.fn(() => true);
      document.execCommand = execCommand as typeof document.execCommand;
    });

    it("mounts a textarea, copies, then removes it", async () => {
      const before = document.body.children.length;
      await copyTextToClipboard("fallback text");
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(document.body.children.length).toBe(before);
    });

    it("selects the full text before issuing the copy command", async () => {
      let selectedValue: string | null = null;
      execCommand.mockImplementation(() => {
        const active = document.activeElement as HTMLTextAreaElement | null;
        selectedValue = active?.value ?? null;
        return true;
      });
      await copyTextToClipboard("select me");
      expect(selectedValue).toBe("select me");
    });

    it("rejects when execCommand returns false", async () => {
      execCommand.mockReturnValue(false);
      await expect(copyTextToClipboard("nope")).rejects.toThrow(/execCommand/);
    });

    it("removes the textarea even if execCommand throws", async () => {
      execCommand.mockImplementation(() => {
        throw new Error("boom");
      });
      const before = document.body.children.length;
      await expect(copyTextToClipboard("boom")).rejects.toThrow("boom");
      expect(document.body.children.length).toBe(before);
    });

    it("restores focus to the previously-focused element", async () => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      expect(document.activeElement).toBe(input);
      await copyTextToClipboard("text");
      expect(document.activeElement).toBe(input);
      input.remove();
    });
  });

  describe("environment without Clipboard API or DOM", () => {
    it("prefers the fallback when navigator.clipboard is missing in a secure context", async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        value: true,
      });
      const execCommand = vi.fn(() => true);
      document.execCommand = execCommand as typeof document.execCommand;

      await copyTextToClipboard("still works");
      expect(execCommand).toHaveBeenCalledWith("copy");
    });
  });
});

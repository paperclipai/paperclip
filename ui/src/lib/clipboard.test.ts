// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", { execCommand });

    await expect(copyTextToClipboard("secret-token")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("secret-token");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const textarea = {
      value: "",
      setAttribute: vi.fn(),
      style: {},
      focus: vi.fn(),
      select: vi.fn(),
    };
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", {
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand,
    });

    await expect(copyTextToClipboard("secret-token")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("secret-token");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false when both clipboard strategies fail", async () => {
    const textarea = {
      value: "",
      setAttribute: vi.fn(),
      style: {},
      focus: vi.fn(),
      select: vi.fn(),
    };
    vi.stubGlobal("navigator", { clipboard: undefined });
    vi.stubGlobal("document", {
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(false),
    });

    await expect(copyTextToClipboard("secret-token")).resolves.toBe(false);
  });
});

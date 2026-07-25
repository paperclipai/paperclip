import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

function installDocumentStub(execCommand: () => boolean) {
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  };
  const doc = {
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    activeElement: null,
    getSelection: vi.fn(() => null),
    execCommand: vi.fn(execCommand),
  };
  vi.stubGlobal("document", doc);
  return { doc, textarea };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyTextToClipboard", () => {
  it("uses the async Clipboard API in a secure context", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { doc } = installDocumentStub(() => true);

    await copyTextToClipboard("ssh agent@host");

    expect(writeText).toHaveBeenCalledWith("ssh agent@host");
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand on a non-secure context even when clipboard exists", async () => {
    // Over plain HTTP the Clipboard API can be present but silently no-op, so we
    // must not trust it and should write via the execCommand path instead.
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { doc, textarea } = installDocumentStub(() => true);

    await copyTextToClipboard("ssh agent@host");

    expect(writeText).not.toHaveBeenCalled();
    expect(textarea.value).toBe("ssh agent@host");
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textarea.select).toHaveBeenCalled();
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, "ssh agent@host".length);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    // Regression guard: Safari silently no-ops execCommand copy from a
    // `readonly` or `opacity: 0` textarea, so the fallback must use neither.
    expect(textarea.setAttribute).not.toHaveBeenCalledWith("readonly", expect.anything());
    expect(textarea.style.opacity).toBeUndefined();
  });

  it("throws when the execCommand fallback reports failure", async () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});
    installDocumentStub(() => false);

    await expect(copyTextToClipboard("x")).rejects.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
import { RESUME_DOCX, RESUME_PDF, SCANNED_PDF } from "../fixtures/slack-files.js";
import { readSlackFileContent } from "./slack-file-content.js";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const PDF = "application/pdf";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function slackFile(bytes: Uint8Array | null, extra: Record<string, unknown> = {}) {
  return {
    id: "F1",
    mimetype: PDF,
    filetype: "pdf",
    size: bytes?.length ?? 0,
    url_private_download: "https://files.slack.com/files-pri/T1-F1/resume.pdf",
    ...extra,
  };
}
const serve = (bytes: Uint8Array) =>
  vi.fn(async () => new Response(bytes as BodyInit)) as unknown as typeof fetch;
/** A conversion that stays running until released, as a native conversion can. */
function pendingConversion() {
  let release: (markdown: string) => void = () => {};
  const convert = vi.fn(
    () => new Promise<string>((resolve) => { release = resolve; }),
  );
  return { convert, release: (markdown = "text") => release(markdown) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(logger.warn).mockClear();
});

describe("readSlackFileContent with the real converter", () => {
  it("extracts the text of a PDF", async () => {
    const fetchImpl = serve(RESUME_PDF);
    const result = await readSlackFileContent(slackFile(RESUME_PDF), "xoxb-test", fetchImpl);
    expect(result.limitation).toBeNull();
    expect(result.content).toContain("Jane Example");
    expect(result.content).toContain("Acme Health");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "files.slack.com" }),
      expect.objectContaining({
        redirect: "error",
        headers: { authorization: "Bearer xoxb-test" },
      }),
    );
  });

  it("extracts the text of a Word document", async () => {
    const result = await readSlackFileContent(
      slackFile(RESUME_DOCX, { mimetype: DOCX, filetype: "docx" }),
      "xoxb-test",
      serve(RESUME_DOCX),
    );
    expect(result.limitation).toBeNull();
    expect(result.content).toContain("Example University");
  });

  it("converts a file that only Slack's filetype identifies", async () => {
    const result = await readSlackFileContent(
      slackFile(RESUME_PDF, { mimetype: "application/octet-stream" }),
      "xoxb-test",
      serve(RESUME_PDF),
    );
    expect(result.content).toContain("Jane Example");
  });

  it("reports a scanned PDF as metadata only without logging an error", async () => {
    const result = await readSlackFileContent(slackFile(SCANNED_PDF), "xoxb-test", serve(SCANNED_PDF));
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/no text layer \(scanned\)/);
    expect(result.limitation).toMatch(/do not claim to have read/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports bytes that are not the advertised document as metadata only", async () => {
    const bytes = Buffer.from("this is not a pdf");
    const result = await readSlackFileContent(slackFile(bytes), "xoxb-test", serve(bytes));
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/could not be converted/);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("readSlackFileContent conversion limits", () => {
  const bytes = Buffer.from("%PDF-1.4 stand-in");

  it.each([
    ["needsOcr", /no text layer/],
    ["encrypted", /encrypted or password-protected/],
    ["resourceLimit", /could not be converted/],
    ["malformed", /could not be converted/],
  ])("maps the %s conversion error to a metadata-only result", async (code, pattern) => {
    const convert = vi.fn().mockRejectedValue(Object.assign(new Error("detail"), { code }));
    const result = await readSlackFileContent(slackFile(bytes), "t", serve(bytes), convert);
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(pattern);
    expect(result.limitation).not.toContain("detail");
  });

  it("logs an unexpected conversion failure but still returns metadata only", async () => {
    const convert = vi.fn().mockRejectedValue(new TypeError("boom"));
    const result = await readSlackFileContent(slackFile(bytes), "t", serve(bytes), convert);
    expect(result.limitation).toMatch(/could not be converted/);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "boom" }),
      "Slack file text extraction failed",
    );
  });

  it("logs and degrades to metadata only when the native binary cannot load", async () => {
    vi.resetModules();
    vi.doMock("@firecrawl/anydoc", () => {
      throw new Error("Cannot find module '@firecrawl/anydoc-linux-x64-gnu'");
    });
    try {
      const { readSlackFileContent: read } = await import("./slack-file-content.js");
      const { logger: freshLogger } = await import("../../middleware/logger.js");
      const result = await read(slackFile(bytes), "t", serve(bytes));
      expect(result).toEqual({
        content: null,
        limitation: expect.stringContaining("could not be converted"),
      });
      // The failure carries no document error code, so it is logged as ours.
      expect(freshLogger.warn).toHaveBeenCalledTimes(1);
      expect(freshLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: undefined, error: expect.any(String) }),
        "Slack file text extraction failed",
      );
    } finally {
      vi.doUnmock("@firecrawl/anydoc");
      vi.resetModules();
    }
  });

  it("reports a document with no extractable text", async () => {
    const result = await readSlackFileContent(slackFile(bytes), "t", serve(bytes), async () => "  \n");
    expect(result.limitation).toMatch(/no extractable text/);
  });

  it("truncates very long text and says so", async () => {
    const result = await readSlackFileContent(
      slackFile(bytes),
      "t",
      serve(bytes),
      async () => "x".repeat(250_000),
    );
    expect(result.content).toHaveLength(200_000);
    expect(result.limitation).toBe("Text truncated at 200000 characters.");
  });

  it("does not cut a surrogate pair in half when truncating", async () => {
    const text = `${"x".repeat(199_999)}😀${"y".repeat(10)}`;
    const result = await readSlackFileContent(slackFile(bytes), "t", serve(bytes), async () => text);
    expect(result.content).toHaveLength(199_999);
    expect(result.content!.endsWith("x")).toBe(true);
  });

  it("stops waiting for a conversion that does not finish", async () => {
    vi.useFakeTimers();
    const { convert, release } = pendingConversion();
    const pending = readSlackFileContent(slackFile(bytes), "t", serve(bytes), convert);
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(pending).resolves.toEqual({
      content: null,
      limitation: expect.stringContaining("took too long"),
    });
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("limits conversions in flight, including ones whose caller stopped waiting", async () => {
    const first = pendingConversion();
    const second = pendingConversion();
    const one = readSlackFileContent(slackFile(bytes), "t", serve(bytes), first.convert);
    const two = readSlackFileContent(slackFile(bytes), "t", serve(bytes), second.convert);
    await vi.waitFor(() => {
      expect(first.convert).toHaveBeenCalled();
      expect(second.convert).toHaveBeenCalled();
    });

    const fetchImpl = serve(bytes);
    const refused = await readSlackFileContent(slackFile(bytes), "t", fetchImpl, vi.fn());
    expect(refused.content).toBeNull();
    expect(refused.limitation).toMatch(/being converted right now/);
    expect(fetchImpl).not.toHaveBeenCalled();

    first.release("one");
    second.release("two");
    await expect(one).resolves.toMatchObject({ content: "one" });
    await expect(two).resolves.toMatchObject({ content: "two" });
    const after = await readSlackFileContent(slackFile(bytes), "t", serve(bytes), async () => "again");
    expect(after.content).toBe("again");
  });

  it("does not download a document over the size limit", async () => {
    const fetchImpl = serve(bytes);
    const convert = vi.fn();
    const result = await readSlackFileContent(
      slackFile(bytes, { size: 6 * 1024 * 1024 }),
      "t",
      fetchImpl,
      convert,
    );
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/over the 5 MB read limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it("rejects a download larger than the limit even when Slack reports a small size", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    await expect(
      readSlackFileContent(slackFile(bytes), "t", serve(big), vi.fn()),
    ).rejects.toThrow("Slack file exceeds the read limit");
  });
});

describe("readSlackFileContent download rules", () => {
  it("still returns small text files as text", async () => {
    const bytes = Buffer.from("hello notes");
    const convert = vi.fn();
    const result = await readSlackFileContent(
      slackFile(bytes, { mimetype: "text/plain", filetype: "text" }),
      "t",
      serve(bytes),
      convert,
    );
    expect(result).toEqual({ content: "hello notes", limitation: null });
    expect(convert).not.toHaveBeenCalled();
  });

  it("returns metadata only for a text file over 256 KB without downloading it", async () => {
    const bytes = Buffer.from("x");
    const fetchImpl = serve(bytes);
    const result = await readSlackFileContent(
      slackFile(bytes, { mimetype: "text/plain", filetype: "text", size: 300 * 1024 }),
      "t",
      fetchImpl,
    );
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/^Metadata only\./);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns metadata only for other file types without downloading", async () => {
    const fetchImpl = serve(Buffer.from("x"));
    const result = await readSlackFileContent(
      slackFile(Buffer.from("x"), { mimetype: "image/png", filetype: "png" }),
      "t",
      fetchImpl,
    );
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/^Metadata only\./);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says so when Slack returns no content for an in-limit document", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const result = await readSlackFileContent(slackFile(RESUME_PDF), "t", fetchImpl, vi.fn());
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/Slack returned no content/);
  });

  it.each([
    "http://files.slack.com/f.pdf",
    "https://evil.example.com/f.pdf",
    "https://files.slack.com:8443/f.pdf",
    "https://user:pw@files.slack.com/f.pdf",
  ])("refuses to download from %s", async (url) => {
    const fetchImpl = serve(Buffer.from("x"));
    await expect(
      readSlackFileContent(
        slackFile(Buffer.from("x"), { url_private_download: url }),
        "t",
        fetchImpl,
        vi.fn(),
      ),
    ).rejects.toThrow("Unsupported Slack file download destination");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when Slack refuses the download", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(
      readSlackFileContent(slackFile(Buffer.from("x")), "t", fetchImpl, vi.fn()),
    ).rejects.toThrow("Slack file content is unavailable");
  });
});

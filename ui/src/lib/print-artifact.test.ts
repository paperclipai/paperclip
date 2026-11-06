/*********
* 
* Aupy Consulting
* 2026
*
********/

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompanyArtifact } from "@/api/artifacts";

import {
  documentMarkdownToHtml,
  planFilePrint,
  printArtifact,
  resolvePrintSource,
  safeArtifactUrl,
} from "./print-artifact";

const ISSUE = { id: "issue-1", identifier: "PAP-7", title: "Printing Artifacts", href: "/PAP/issues/PAP-7" };

function artifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "artifact-1",
    source: "attachment",
    mediaKind: "file",
    title: "Evidence",
    previewText: null,
    contentType: "text/plain",
    contentPath: "/api/attachments/abc/content",
    openPath: "/api/attachments/abc/content?raw=1",
    downloadPath: "/api/attachments/abc/content?download=1",
    issue: ISSUE as CompanyArtifact["issue"],
    project: null,
    createdByAgent: null,
    updatedAt: "2026-09-28T20:00:00.000Z",
    href: "/PAP/issues/PAP-7#attachment-abc",
    ...overrides,
  } as CompanyArtifact;
}

describe("resolvePrintSource", () => {
  it("prefers the file paths of attachment artifacts", () => {
    expect(resolvePrintSource(artifact())).toEqual({
      kind: "file",
      url: "/api/attachments/abc/content?raw=1",
    });
  });

  it("falls back through contentPath and downloadPath", () => {
    expect(resolvePrintSource(artifact({ openPath: null }))).toEqual({
      kind: "file",
      url: "/api/attachments/abc/content",
    });
    expect(resolvePrintSource(artifact({ openPath: null, contentPath: null }))).toEqual({
      kind: "file",
      url: "/api/attachments/abc/content?download=1",
    });
  });

  it("resolves document artifacts from their href fragment", () => {
    expect(
      resolvePrintSource(
        artifact({
          source: "document",
          mediaKind: "document",
          contentPath: null,
          openPath: null,
          downloadPath: null,
          href: "/PAP/issues/PAP-7#document-design-notes",
        }),
      ),
    ).toEqual({ kind: "document", issueId: "issue-1", documentKey: "design-notes" });
  });

  it("returns none when there is nothing printable", () => {
    expect(
      resolvePrintSource(
        artifact({
          mediaKind: "empty",
          contentPath: null,
          openPath: null,
          downloadPath: null,
          href: "/PAP/issues/PAP-7",
        }),
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("planFilePrint", () => {
  it("prints PDFs and images from the browser viewer", () => {
    expect(planFilePrint("application/pdf")).toBe("inline");
    expect(planFilePrint("image/png")).toBe("inline");
    expect(planFilePrint("image/png; charset=binary")).toBe("inline");
  });

  it("prints text and structured text as preformatted text", () => {
    expect(planFilePrint("text/plain")).toBe("text");
    expect(planFilePrint("text/markdown")).toBe("text");
    expect(planFilePrint("application/json")).toBe("text");
    expect(planFilePrint("application/vnd.paperclip+json")).toBe("text");
  });

  it("hands untrusted markup to the browser instead of printing it", () => {
    expect(planFilePrint("text/html")).toBe("handoff");
    expect(planFilePrint("text/html; charset=utf-8")).toBe("handoff");
    expect(planFilePrint("image/svg+xml")).toBe("handoff");
  });

  it("hands binaries to the browser instead of printing bytes as text", () => {
    expect(
      planFilePrint("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("handoff");
    expect(planFilePrint("video/mp4")).toBe("handoff");
  });

  it("falls back to the artifact kind when no content type is recorded", () => {
    expect(planFilePrint(null, "image")).toBe("inline");
    expect(planFilePrint(null, "text")).toBe("text");
    expect(planFilePrint(null, "file")).toBe("handoff");
    expect(planFilePrint("", "empty")).toBe("handoff");
  });
});

describe("safeArtifactUrl", () => {
  it("keeps http(s), mailto, relative paths and fragments", () => {
    expect(safeArtifactUrl("https://example.com/report.pdf")).toBe("https://example.com/report.pdf");
    expect(safeArtifactUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(safeArtifactUrl("/api/attachments/abc/content")).toBe("/api/attachments/abc/content");
    expect(safeArtifactUrl("#section-2")).toBe("#section-2");
  });

  it("drops script and data URLs", () => {
    expect(safeArtifactUrl("javascript:alert(1)")).toBeNull();
    expect(safeArtifactUrl("JavaScript:alert(1)")).toBeNull();
    expect(safeArtifactUrl("java\nscript:alert(1)")).toBeNull();
    expect(safeArtifactUrl(" data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeArtifactUrl("vbscript:msgbox(1)")).toBeNull();
  });
});

describe("documentMarkdownToHtml", () => {
  it("renders headings, lists and code fences", () => {
    const html = documentMarkdownToHtml("# Title\n\n- one\n- two\n\n```\nconst a = 1;\n```\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
    expect(html).toContain("<pre>");
    expect(html).toContain("const a = 1;");
  });

  it("keeps nested list items inside their parent item", () => {
    const html = documentMarkdownToHtml("- one\n  - one a\n  - one b\n- two\n");
    expect(html).toContain("<li>one<ul><li>one a</li><li>one b</li></ul></li>");
    expect(html).toContain("<li>two</li>");
  });

  it("closes one list before starting another style at the same level", () => {
    const html = documentMarkdownToHtml("- bullet\n\n1. number\n");
    expect(html).toContain("<ul><li>bullet</li></ul>");
    expect(html).toContain("<ol><li>number</li></ol>");
  });

  it("keeps tables readable as fixed-width blocks", () => {
    const html = documentMarkdownToHtml("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).toContain('<pre class="tbl">');
    expect(html).toContain("| 1 | 2 |");
  });

  it("escapes markup instead of trusting document content", () => {
    const html = documentMarkdownToHtml('<img src=x onerror="alert(1)">');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it("keeps links but drops script URLs", () => {
    expect(documentMarkdownToHtml("[spec](https://example.com/spec)")).toContain(
      '<a href="https://example.com/spec" target="_blank" rel="noreferrer noopener">spec</a>',
    );

    const unsafe = documentMarkdownToHtml("[click me](javascript:alert(1))");
    expect(unsafe).toContain("click me");
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).not.toContain("<a ");
  });

  it("renders images with a safe src and falls back to alt text otherwise", () => {
    expect(documentMarkdownToHtml("![shot](/api/attachments/abc/content)")).toContain(
      '<img src="/api/attachments/abc/content" alt="shot">',
    );

    const unsafe = documentMarkdownToHtml("![shot](javascript:alert(1))");
    expect(unsafe).toContain("shot");
    expect(unsafe).not.toContain("<img");
    expect(unsafe).not.toContain("javascript:");
  });
});

type FakeTarget = {
  document: { open: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  location: { replace: ReturnType<typeof vi.fn> };
  focus: ReturnType<typeof vi.fn>;
  print: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  dispatchLoad: () => void;
};

function fakeTarget(): { target: FakeTarget; written: () => string } {
  const writes: string[] = [];
  const loadListeners: Array<() => void> = [];
  const target: FakeTarget = {
    document: {
      open: vi.fn(),
      write: vi.fn((html: string) => writes.push(html)),
      close: vi.fn(),
    },
    location: { replace: vi.fn() },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "load") loadListeners.push(listener);
    }),
    dispatchLoad: () => loadListeners.splice(0).forEach((listener) => listener()),
  };
  return { target, written: () => writes.join("") };
}

function stubWindow(openMock: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("window", {
    open: openMock,
    // Print immediately so a test never waits on the real delay.
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
  });
}

/** Hold timers so a test can assert what has and has not run yet. */
function stubWindowWithTimers(openMock: ReturnType<typeof vi.fn>): Array<() => void> {
  const queued: Array<() => void> = [];
  vi.stubGlobal("window", {
    open: openMock,
    setTimeout: (callback: () => void) => {
      queued.push(callback);
      return 0;
    },
  });
  return queued;
}

function runTimers(queued: Array<() => void>): void {
  while (queued.length > 0) queued.splice(0).forEach((callback) => callback());
}

describe("printArtifact", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens no tab when the artifact has nothing to print", () => {
    const openMock = vi.fn();
    stubWindow(openMock);

    printArtifact(
      artifact({
        mediaKind: "empty",
        contentPath: null,
        openPath: null,
        downloadPath: null,
        href: "/PAP/issues/PAP-7",
      }),
    );

    expect(openMock).not.toHaveBeenCalled();
  });

  it("never writes attachment HTML into the app document", () => {
    const openMock = vi.fn();
    stubWindow(openMock);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { target, written } = fakeTarget();
    openMock.mockReturnValue(target);

    printArtifact(artifact({ contentType: "text/html", openPath: "/api/attachments/evil/content" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(written()).toBe("");
    expect(target.document.write).not.toHaveBeenCalled();
    expect(target.location.replace).toHaveBeenCalledWith("/api/attachments/evil/content");
  });

  it("hands a binary to the browser instead of printing bytes as text", () => {
    const openMock = vi.fn();
    stubWindow(openMock);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { target, written } = fakeTarget();
    openMock.mockReturnValue(target);

    printArtifact(
      artifact({
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(written()).toBe("");
    expect(target.location.replace).toHaveBeenCalledWith("/api/attachments/abc/content?raw=1");
  });

  it("prints a PDF by navigating to the attachment URL, not a blob URL", () => {
    const openMock = vi.fn();
    stubWindow(openMock);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { target, written } = fakeTarget();
    openMock.mockReturnValue(target);

    printArtifact(artifact({ contentType: "application/pdf" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(written()).toBe("");
    expect(target.location.replace).toHaveBeenCalledWith("/api/attachments/abc/content?raw=1");
    expect(target.print).toHaveBeenCalled();
  });

  it("waits for the file to load before printing it", () => {
    const openMock = vi.fn();
    const queued = stubWindowWithTimers(openMock);
    const { target } = fakeTarget();
    openMock.mockReturnValue(target);

    printArtifact(artifact({ contentType: "application/pdf" }));

    // Navigation is under way and the fallback timer is pending: not printed yet.
    expect(target.addEventListener).toHaveBeenCalledWith(
      "load",
      expect.any(Function),
      { once: true },
    );
    expect(target.print).not.toHaveBeenCalled();

    // The file loads, the viewer gets a settle delay, then the tab is printed.
    target.dispatchLoad();
    expect(target.print).not.toHaveBeenCalled();
    runTimers(queued);
    expect(target.print).toHaveBeenCalledTimes(1);

    // A late second load event must not print a second time.
    target.dispatchLoad();
    runTimers(queued);
    expect(target.print).toHaveBeenCalledTimes(1);
  });

  it("prints the tab anyway when the load event never arrives", () => {
    const openMock = vi.fn();
    const queued = stubWindowWithTimers(openMock);
    const { target } = fakeTarget();
    openMock.mockReturnValue(target);

    printArtifact(artifact({ contentType: "image/png", mediaKind: "image" }));

    expect(target.print).not.toHaveBeenCalled();
    runTimers(queued); // the fallback timer fires after the load timeout
    expect(target.print).toHaveBeenCalledTimes(1);
  });

  it("prints text content as preformatted text", async () => {
    const openMock = vi.fn();
    stubWindow(openMock);
    const fetchMock = vi.fn(async () => new Response("line one\nline two", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { target, written } = fakeTarget();
    openMock.mockReturnValue(target);

    printArtifact(artifact({ contentType: "text/plain" }));

    await vi.waitFor(() => expect(target.print).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/abc/content?raw=1", {
      credentials: "same-origin",
    });
    expect(written()).toContain("<pre>line one\nline two</pre>");
  });

  it("prints a document body from the issue document endpoint", async () => {
    const openMock = vi.fn();
    stubWindow(openMock);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ body: "# Notes\n\n- one\n" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { target, written } = fakeTarget();
    openMock.mockReturnValue(target);

    printArtifact(
      artifact({
        source: "document",
        mediaKind: "document",
        contentPath: null,
        openPath: null,
        downloadPath: null,
        href: "/PAP/issues/PAP-7#document-design-notes",
      }),
    );

    await vi.waitFor(() => expect(target.print).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/issues/issue-1/documents/design-notes", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    expect(written()).toContain("<h1>Notes</h1>");
    expect(written()).toContain("<li>one</li>");
  });
});

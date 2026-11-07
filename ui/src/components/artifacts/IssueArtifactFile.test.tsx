// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { IssueArtifactFile } from "./IssueArtifactCard";
import { loadArtifactCsv } from "@/lib/artifact-card-data";
import { TextAttachmentContext } from "@/context/TextAttachmentContext";

vi.mock("@/lib/artifact-card-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifact-card-data")>()),
  loadArtifactCsv: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CSV preview consent", () => {
  it("does not fetch any CSV until its preview is requested", async () => {
    const load = vi
      .mocked(loadArtifactCsv)
      .mockResolvedValue({
        columns: ["Name"],
        rows: [["Actual row"]],
        truncated: false,
      });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const openText = vi.fn();
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <TextAttachmentContext.Provider value={openText}>
              {Array.from({ length: 20 }, (_, i) => (
                <IssueArtifactFile
                  key={i}
                  id={`csv-${i}`}
                  attachmentId={`attachment-${i}`}
                  title={`Data ${i}`}
                  summary=""
                  author=""
                  updatedAt="Today"
                  filename={`report-${i}.csv`}
                  contentType="text/csv"
                  contentPath={`/api/attachments/csv-${i}/content`}
                  downloadPath={`/api/attachments/csv-${i}/content?download=1`}
                  byteSize={100}
                />
              ))}
            </TextAttachmentContext.Provider>
          </QueryClientProvider>,
        ),
      );
      expect(load).not.toHaveBeenCalled();
      const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open in tab: Data 0"]');
      await act(async () => open!.click());
      expect(openText).toHaveBeenCalledWith("attachment-0", "report-0.csv");
      expect(load).not.toHaveBeenCalled();
      const preview = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Preview data",
      );
      expect(preview).toBeDefined();
      await act(async () => preview!.click());
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Actual row"),
      );
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith(
        "/api/attachments/csv-0/content",
        expect.any(AbortSignal),
      );
      expect(container.textContent).toContain("View data");
      const download = container.querySelector<HTMLAnchorElement>('a[download="report-0.csv"]');
      expect(download?.textContent).toBe("Download file");
      expect(download?.getAttribute("href")).toBe("/api/attachments/csv-0/content?download=1");
      const openAfterPreview = container.querySelector<HTMLButtonElement>('button[aria-label="Open in tab: Data 0"]');
      await act(async () => openAfterPreview!.click());
      expect(openText).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      vi.clearAllMocks();
    }
  });
});


describe("inline patch attachment preview", () => {
  const text = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+<script>new</script>\n";
  async function mount(overrides: Partial<React.ComponentProps<typeof IssueArtifactFile>> = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><IssueArtifactFile
      id="patch" attachmentId="patch" title="Fix preview" summary="" author="" updatedAt="Today"
      filename="fix.patch" contentType="application/octet-stream" byteSize={100}
      contentPath="/api/attachments/patch/content" downloadPath="/api/attachments/patch/content?download=1"
      {...overrides}
    /></QueryClientProvider>));
    return { container, cleanup: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); } };
  }

  it("does not fetch patch attachments in a large collection until one preview is requested", async () => {
    const fetch = vi.fn(async () => new Response(text)); vi.stubGlobal("fetch", fetch);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}>
        {Array.from({ length: 200 }, (_, index) => <IssueArtifactFile key={index}
          id={`patch-${index}`} attachmentId={`patch-${index}`} title={`Patch ${index}`} summary="" author="" updatedAt="Today"
          filename={`fix-${index}.patch`} contentType="text/x-patch" byteSize={512 * 1024}
          contentPath={`/api/attachments/patch-${index}/content`} downloadPath={`/api/attachments/patch-${index}/content?download=1`}
        />)}
      </QueryClientProvider>));
      expect(fetch).not.toHaveBeenCalled();
      const preview = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Preview patch");
      expect(preview).toBeDefined();
      await act(async () => preview!.click());
      await vi.waitFor(() => expect(container.querySelector('[data-patch-line="add"]')).not.toBeNull());
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith("/api/attachments/patch-0/content", expect.anything());
    } finally { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); }
  });

  it.each([
    { filename: "fix.patch", contentType: "application/octet-stream" },
    { filename: "download", contentType: "text/x-diff" },
  ])("loads and highlights $filename in the real card", async (overrides) => {
    const fetch = vi.fn().mockResolvedValue(new Response(text)); vi.stubGlobal("fetch", fetch);
    const { container, cleanup } = await mount(overrides);
    try {
      expect(fetch).not.toHaveBeenCalled();
      const preview = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Preview patch");
      await act(async () => preview!.click());
      await vi.waitFor(() => expect(container.querySelector('[data-patch-line="add"]')).not.toBeNull());
      expect(container.querySelector("pre")?.textContent).toBe(text);
      expect(container.querySelector("script")).toBeNull();
      expect(container.querySelector('a[download]')?.getAttribute("href")).toBe("/api/attachments/patch/content?download=1");
      expect(fetch).toHaveBeenCalledWith("/api/attachments/patch/content", expect.objectContaining({ credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) }));
    } finally { await cleanup(); }
  });

  it.each([
    { contentPath: "https://example.com/fix.patch" },
    { byteSize: 512 * 1024 + 1 },
    { filename: "notes.txt", contentType: "text/plain" },
  ])("keeps the download fallback without fetching ineligible source %j", async (overrides) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { container, cleanup } = await mount(overrides);
    try {
      expect(fetch).not.toHaveBeenCalled();
      expect(container.querySelector('a[download]')).not.toBeNull();
      expect(container.querySelector('[data-patch-line]')).toBeNull();
    } finally { await cleanup(); }
  });

  it("keeps download after a load failure and retries the patch preview", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Patch preview failed")).mockResolvedValueOnce(new Response(text));
    vi.stubGlobal("fetch", fetch);
    const { container, cleanup } = await mount();
    try {
      const preview = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Preview patch");
      await act(async () => preview!.click());
      await vi.waitFor(() => expect(container.textContent).toContain("Patch preview failed"));
      expect(container.querySelector('a[download]')).not.toBeNull();
      const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Retry"));
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      await vi.waitFor(() => expect(container.querySelector('[data-patch-line="add"]')).not.toBeNull());
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await cleanup(); }
  });
});

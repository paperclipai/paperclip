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

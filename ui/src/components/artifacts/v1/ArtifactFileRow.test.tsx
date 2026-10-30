// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { TextAttachmentContext } from "@/context/TextAttachmentContext";
import { ArtifactFileRow } from "./ArtifactFileRow";
import { testSubject } from "./test-subject";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const csvLoader = vi.hoisted(() => vi.fn(async () => ({ columns: ["units", "unit_price"], rows: [[24, 24], [48, 21]], truncated: false })));
vi.mock("@/lib/artifact-card-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/artifact-card-data")>("@/lib/artifact-card-data");
  return { ...actual, loadArtifactCsv: csvLoader };
});
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null, selectedCompanyId: null, companies: [] }) }));

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const source = (overrides: Partial<Parameters<typeof ArtifactFileRow>[0]["source"]> = {}) => ({
  id: "f1",
  attachmentId: ATTACHMENT_ID,
  filename: "pricing.csv",
  contentType: "text/csv",
  contentPath: `/api/attachments/${ATTACHMENT_ID}/content`,
  openPath: `/api/attachments/${ATTACHMENT_ID}/content?inline=1`,
  downloadPath: `/api/attachments/${ATTACHMENT_ID}/content?download=1`,
  byteSize: 2380,
  ...overrides,
});

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ArtifactFileRow", () => {
  let container: HTMLDivElement;
  let root: Root;
  const mount = (ui: React.ReactNode) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    csvLoader.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the CSV data preview: Preview data loads the table under the row", async () => {
    mount(<ArtifactFileRow subject={testSubject({ kind: "sheet", filename: "pricing.csv", contentType: "text/csv", sizeLabel: "2.3 KB" })} source={source()} />);
    const preview = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === "Preview data");
    expect(preview).toBeDefined();
    act(() => preview!.click());
    for (let i = 0; i < 20 && !container.textContent?.includes("unit_price"); i += 1) await act(flush);
    expect(csvLoader).toHaveBeenCalledWith(`/api/attachments/${ATTACHMENT_ID}/content`, expect.anything());
    expect(container.textContent).toContain("unit_price");
    expect(container.querySelector(`a[aria-label="Download pricing.csv"]`)?.getAttribute("href")).toContain("download=1");
  });

  it("opens text in the text tab on a plain click while the row stays a link", () => {
    const openText = vi.fn();
    mount(
      <TextAttachmentContext.Provider value={openText}>
        <ArtifactFileRow subject={testSubject({ kind: "document", filename: "notes.md" })} source={source({ filename: "notes.md", contentType: "text/markdown" })} />
      </TextAttachmentContext.Provider>,
    );
    const link = container.querySelector<HTMLAnchorElement>('a[data-testid="artifact-v1-row-open"]')!;
    expect(link.getAttribute("href")).toContain("inline=1");
    act(() => { link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
    expect(openText).toHaveBeenCalledWith(ATTACHMENT_ID, "notes.md");
  });

  it("opens a picture in the task's gallery and keeps open raw and download beside it", () => {
    const openGallery = vi.fn(() => true);
    mount(
      <IssueGalleryContext.Provider value={openGallery}>
        <ArtifactFileRow subject={testSubject({ kind: "image", filename: "hero.png", thumbnailUrl: "/api/attachments/x/content" })} source={source({ filename: "hero.png", contentType: "image/png", contentPath: "/api/attachments/x/content" })} />
      </IssueGalleryContext.Provider>,
    );
    act(() => container.querySelector<HTMLButtonElement>('button[data-testid="artifact-v1-row-open"]')!.click());
    expect(openGallery).toHaveBeenCalledWith("/api/attachments/x/content");
    expect(container.querySelector('a[aria-label="Open raw hero.png"]')).not.toBeNull();
    expect(container.querySelector('a[aria-label="Download hero.png"]')).not.toBeNull();
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactSingleTile, ArtifactStackTile, ArtifactTileGrid } from "./ArtifactTile";
import { testSubject } from "./test-subject";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null, companies: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-28T18:00:00");

describe("the Artifacts page tiles", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a stack as a link with the task's pill, its count and when it changed", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactStackTile identifier="ACM-3" title="Create visual directions" count={21} updatedAt="2026-09-28T11:07:00" front={testSubject({ kind: "pdf", filename: "deck.pdf" })} to="/artifacts?issue=i3" now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const link = container.querySelector('a[data-testid="artifact-v1-stack-tile"]');
    expect(link?.getAttribute("href")).toBe("/artifacts?issue=i3");
    expect(link?.className).toContain("artifact-tile");
    expect(container.querySelector("[data-artifact-pill]")?.textContent).toBe("ACM-3");
    expect(link?.textContent).toContain("21 Artifacts");
    expect(link?.textContent).toContain("Updated 11:07 AM");
    expect(container.querySelector('[data-artifact-stack="sheet"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-artifact-spread]")).toHaveLength(2);
  });

  it("renders a picture stack on the media backing with a fitted print", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactStackTile identifier="ACM-5" title="Shoot cap product photos" count={6} updatedAt="2026-09-27T15:12:00" front={testSubject({ kind: "image", thumbnailUrl: "/cap.png", aspect: 3 / 2 })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    expect(container.querySelector('[data-artifact-stack="media"]')).not.toBeNull();
    const print = container.querySelector<HTMLElement>("[data-artifact-print]");
    expect(print?.style.width).toBe("245px");
    expect(print?.style.height).toBe("163.33px");
  });

  it("plays a video's own stream in the print when it has no poster, never an image tag on the video", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactSingleTile subject={testSubject({ kind: "video", filename: "reel.webm", videoUrl: "/api/files/reel.webm" })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const print = container.querySelector("[data-artifact-print]");
    expect(print?.querySelector("video")?.getAttribute("src")).toBe("/api/files/reel.webm");
    expect(print?.querySelector("img")).toBeNull();
  });

  it("renders a single artifact as a button named after its file, with the sheet treatment", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactSingleTile subject={testSubject({ kind: "document", title: "Brand strategy", filename: "brand-strategy-brief.md", hasText: true, taskIdentifier: "ACM-2" })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const button = container.querySelector('button[data-testid="artifact-v1-single-tile"]');
    expect(button?.getAttribute("aria-label")).toBe("Open brand-strategy-brief.md");
    expect(container.querySelector('[data-artifact-sheet="preview"]')?.textContent).toContain("Brand strategy");
    expect(container.querySelector("[data-artifact-front]")).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { DocumentMarkdownBody } from "./DocumentMarkdownBody";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

const body = "![First](/first.png)\n\n![Second][shot]\n\n![Repeated](/first.png)\n\n[shot]: https://example.com/second.png";
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output>{location.pathname}{location.search}{location.hash}</output><button onClick={() => navigate(-1)}>Back</button></>;
}
async function render(hash = "", markdown = body, revisionId?: string, documentIssueId?: string, currentIssueId?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[`/PAP/issues/example?keep=1${hash}`]}>
      <QueryClientProvider client={client}><ThemeProvider>
        <DocumentMarkdownBody documentKey="report" revisionId={revisionId} documentIssueId={documentIssueId} currentIssueId={currentIssueId}>{markdown}</DocumentMarkdownBody>
        <LocationProbe />
      </ThemeProvider></QueryClientProvider>
    </MemoryRouter>);
  });
}
async function click(selector: string) {
  const element = document.querySelector<HTMLElement>(selector)!;
  expect(element).not.toBeNull();
  await act(async () => element.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function key(key: string) {
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function dialog() { return document.querySelector('[role="dialog"]'); }

describe("document image gallery", () => {
  it("opens a clicked occurrence, navigates all rendered images, and updates the URL", async () => {
    await render("#document-report&viewer=full&thread=thread-1");
    await click('[aria-label="Open image: Repeated"]');
    expect(dialog()?.textContent).toContain("3 / 3");
    expect(dialog()?.querySelector("img")?.getAttribute("src")).toBe("/first.png");
    expect(container.querySelector("output")?.textContent).toBe("/PAP/issues/example?keep=1#document-report&thread=thread-1&viewer=full&image=3");
    await key("ArrowRight");
    expect(dialog()?.textContent).toContain("1 / 3");
    await click('button[title="Next"]');
    expect(dialog()?.querySelector("img")?.getAttribute("src")).toBe("https://example.com/second.png");
    expect(container.querySelector("output")?.textContent).toContain("image=2");
    await key("ArrowLeft");
    expect(dialog()?.textContent).toContain("1 / 3");
    await click('button[title="Previous"]');
    expect(dialog()?.textContent).toContain("3 / 3");
    await key("Escape");
    expect(dialog()).toBeNull();
    expect(container.querySelector("output")?.textContent).not.toContain("image=");
    expect(container.querySelector("output")?.textContent).toContain("viewer=full");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open image: Repeated");
  });

  it("loads a shared image URL for the exact revision and retains it on close", async () => {
    await render("#document-report&revision=old&interaction=review&documentIssue=owner&image=2", body, "old", "owner");
    expect(dialog()?.textContent).toContain("2 / 3");
    expect(dialog()?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/second.png");
    await click('button[title="Close"]');
    expect(container.querySelector("output")?.textContent).toContain("#document-report&revision=old&interaction=review&documentIssue=owner");
    expect(dialog()).toBeNull();
  });

  it("opens a saved owner after the URL has changed to another document", async () => {
    await render("#document-local&documentIssue=wrong-owner", body, "old", "owner");
    await click('[aria-label="Open image: First"]');
    expect(dialog()?.textContent).toContain("1 / 3");
    expect(container.querySelector("output")?.textContent).toContain("#document-report&revision=old&documentIssue=owner&image=1");
    await key("ArrowRight");
    expect(container.querySelector("output")?.textContent).toContain("documentIssue=owner&image=2");
  });

  it("opens an explicit current-task link and keeps review parameters through navigation and reopening", async () => {
    await render("#document-report&revision=old&interaction=review&viewer=full&documentIssue=current-task&image=2", body, "old", undefined, "current-task");
    expect(dialog()?.textContent).toContain("2 / 3");
    await key("ArrowRight");
    expect(dialog()?.textContent).toContain("3 / 3");
    await click('button[title="Close"]');
    expect(dialog()).toBeNull();
    await click('[aria-label="Open image: First"]');
    expect(dialog()?.textContent).toContain("1 / 3");
    const url = container.querySelector("output")?.textContent;
    expect(url).toContain("revision=old");
    expect(url).toContain("interaction=review");
    expect(url).toContain("viewer=full");
    expect(url).toContain("documentIssue=current-task");
  });

  it("does not match another task's saved tab to an implicit current-task link", async () => {
    await render("#document-report&revision=old&image=2", body, "old", "other-task", "current-task");
    expect(dialog()).toBeNull();
    await click('[aria-label="Open image: First"]');
    expect(dialog()?.textContent).toContain("1 / 3");
    expect(container.querySelector("output")?.textContent).toContain("documentIssue=other-task");
  });

  it.each(["#document-other&image=1", "#document-report&image=100", "#document-report&image=0", "#document-report&revision=old&image=1"])("does not open an unavailable image target: %s", async (hash) => {
    await render(hash);
    expect(dialog()).toBeNull();
  });

  it("opens a single image from the keyboard without navigation controls", async () => {
    await render("", "![Only](/only.png)");
    const image = container.querySelector("img")!;
    await act(async () => {
      image.focus();
      image.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(dialog()?.textContent).toContain("1 / 1");
    expect(dialog()?.querySelector('button[title="Next"]')).toBeNull();
    await click('[role="dialog"]');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(image);
  });
});

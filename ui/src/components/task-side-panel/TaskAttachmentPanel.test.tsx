// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskAttachmentPanel, TextAttachmentPreview, readTextPreview, TEXT_PREVIEW_MAX_BYTES } from "./TaskAttachmentPanel";
import { isTextAttachment } from "@/lib/issue-attachments";
import { readTaskSidePanelState, taskPanelAttachmentTab, writeTaskSidePanelState } from "@/lib/task-side-panel-state";
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <article data-rendered>{children}</article> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("text attachment tabs", () => {
  it("does not fetch missing or oversized attachments and offers download for oversized files", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(queryKeys.issues.attachments("task"), [{ id: "large", originalFilename: "large.txt", contentType: "text/plain", byteSize: TEXT_PREVIEW_MAX_BYTES + 1, contentPath: "/api/attachments/large/content" }]);
    const host = document.createElement("div"); const root = createRoot(host);
    await act(async () => root.render(<QueryClientProvider client={client}><TaskAttachmentPanel issueId="task" attachmentId="missing" /></QueryClientProvider>));
    expect(host.textContent).toContain("File no longer available");
    await act(async () => root.render(<QueryClientProvider client={client}><TaskAttachmentPanel issueId="task" attachmentId="large" /></QueryClientProvider>));
    expect(host.textContent).toContain("too large");
    expect(host.querySelector("a")?.textContent).toBe("Download file");
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => root.unmount()); client.clear();
  });

  it("classifies text without treating PDF or images as text", () => {
    for (const [contentType, originalFilename] of [["text/plain", "notes.txt"], ["application/octet-stream", "AGENTS.md"], ["application/json", "report.json"]]) expect(isTextAttachment({ contentType, originalFilename })).toBe(true);
    expect(isTextAttachment({ contentType: "application/pdf", originalFilename: "report.pdf" })).toBe(false);
    expect(isTextAttachment({ contentType: "image/png", originalFilename: "fake.txt" })).toBe(false);
  });
  it("retains attachment tabs when workspace browsing is disabled", () => {
    const tab = taskPanelAttachmentTab("file-1", "AGENTS.md");
    writeTaskSidePanelState("user", "company", "task", { state: { tabs: [tab], activeTabId: tab.id }, launcherOpen: false, userInteracted: true, autoPlanHandled: false, updatedAt: 1 });
    expect(readTaskSidePanelState("user", "company", "task", false)?.state.tabs).toEqual([tab]);
    expect(taskPanelAttachmentTab("file-1", "Renamed.md").id).toBe(tab.id);
  });
  it("switches rendered/raw Markdown and keeps a download action", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<TextAttachmentPreview title="AGENTS.md" markdown text="# Charter" downloadUrl="/api/attachments/file-1/content?download=1" />));
    expect(host.querySelector("[data-rendered]")).not.toBeNull();
    const raw = host.querySelector<HTMLButtonElement>('button[aria-label="Raw"]');
    const rendered = host.querySelector<HTMLButtonElement>('button[aria-label="Rendered"]');
    expect(raw?.querySelector("svg")).not.toBeNull();
    expect(rendered?.querySelector("svg")).not.toBeNull();
    expect(raw?.textContent).toBe("");
    await act(async () => raw!.click());
    expect(host.querySelector("pre")?.textContent).toBe("# Charter");
    expect(host.querySelector("a")?.getAttribute("href")).toContain("download=1");
    await act(async () => rendered!.click());
    expect(host.querySelector("[data-rendered]")).not.toBeNull();
    await act(async () => root.unmount()); host.remove();
  });
  it("renders CSV cells safely and switches to the exact raw source beside download", async () => {
    const host = document.createElement("div"); const root = createRoot(host);
    const text = 'Name,Notes,Amount\n"Lee, Sam","<script>hello</script>",12\nJo,"line 1\nline 2",';
    await act(async () => root.render(<TextAttachmentPreview title="export.csv" markdown={false} csv text={text} downloadUrl="/download" />));
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.textContent).toContain("2 rows");
    expect(host.querySelector("td")?.textContent).toBe("Lee, Sam");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("header")?.lastElementChild?.getAttribute("href")).toBe("/download");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Raw"]')!.click());
    expect(host.querySelector("pre")?.textContent).toBe(text);
    expect(host.querySelector("table")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Rendered"]')!.click());
    expect(host.querySelector("table")).not.toBeNull();
    await act(async () => root.unmount());
  });
  it("shows plain text literally without Markdown controls", async () => {
    const host = document.createElement("div"); const root = createRoot(host);
    await act(async () => root.render(<TextAttachmentPreview title="notes.txt" markdown={false} text="<script>alert(1)</script>" downloadUrl="/download" />));
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toContain("<script>");
    expect(host.querySelector('[aria-label="Markdown view"]')).toBeNull();
    expect(host.querySelector('a[aria-label="Download notes.txt"] svg')).not.toBeNull();
    await act(async () => root.unmount());
  });
  it("rejects HTTP errors, oversized responses and binary data", async () => {
    await expect(readTextPreview(new Response("denied", { status: 403 }))).rejects.toThrow("403");
    await expect(readTextPreview(new Response("x".repeat(TEXT_PREVIEW_MAX_BYTES + 1)))).rejects.toThrow("too large");
    await expect(readTextPreview(new Response("binary\0data"))).rejects.toThrow("binary");
    expect(await readTextPreview(new Response(""))).toBe("");
    expect(await readTextPreview(new Response("héllo"))).toBe("héllo");
  });
});

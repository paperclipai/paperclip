// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedWorkspaceResource, WorkspaceFileContent } from "@paperclipai/shared";
import { FileViewerSheet } from "./FileViewerSheet";

const useQueryMock = vi.fn();
const viewerMock = {
  state: null,
  browse: false,
  query: null,
  folderPath: null,
  browseProjectId: null,
  browseWorkspaceId: null,
  open: vi.fn(),
  updateBrowseState: vi.fn(),
  close: vi.fn(),
  backToFiles: vi.fn(),
};

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (options: unknown) => useQueryMock(options),
  };
});

vi.mock("@/context/FileViewerContext", () => ({
  useRequiredFileViewer: () => viewerMock,
}));

vi.mock("@/components/WorkspaceFileBrowser", () => ({
  WorkspaceFileBrowser: () => null,
}));

vi.mock("@/components/WorkspaceFileMarkdownBody", () => ({
  WorkspaceFileMarkdownBody: ({ children }: { children: string }) => (
    <div data-testid="mock-rendered-markdown">Rendered Markdown: {children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok<T>(data: T) {
  return { data, isFetching: false, isError: false, error: null, refetch: vi.fn(async () => ({ data })) };
}

const resolvedResource: ResolvedWorkspaceResource = {
  kind: "file",
  provider: "git_worktree",
  title: "tweet.md",
  displayPath: "videos/90-days-paperclip/tweet.md",
  workspaceLabel: "Isolated workspace",
  workspaceKind: "execution_workspace",
  workspaceId: "ws-1",
  contentType: "text/markdown; charset=utf-8",
  byteSize: 42,
  previewKind: "text",
  capabilities: { preview: true, download: false, listChildren: false },
};

const content: WorkspaceFileContent = {
  resource: resolvedResource,
  content: {
    encoding: "utf8",
    data: "hello from the file",
  },
};

describe("FileViewerSheet copy actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useQueryMock.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      const key = JSON.stringify(options.queryKey ?? []);
      if (key.includes('"content"')) return ok(content);
      return ok(resolvedResource);
    });
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    window.history.pushState({}, "", "/PAP/issues/PAP-10629?file=videos%2F90-days-paperclip%2Ftweet.md");
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function renderSheet() {
    flushSync(() => {
      root.render(
        <FileViewerSheet
          issueId="issue-1"
          state={{
            path: "videos/90-days-paperclip/tweet.md",
            workspace: "auto",
            line: null,
            column: null,
            projectId: null,
            workspaceId: null,
          }}
          open
        />,
      );
    });
  }

  async function click(label: string) {
    const button = document.body.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    flushSync(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("copies file contents and shows confirmation", async () => {
    renderSheet();

    await click("Copy file contents");

    expect(writeText).toHaveBeenCalledWith("hello from the file");
    expect(document.body.textContent).toContain("Copied contents");
  });

  it("copies the current file view link and shows confirmation", async () => {
    renderSheet();

    await click("Copy link to this file view");

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(document.body.textContent).toContain("Copied link");
  });

  it("renders a keyboard-addressable file tree resize separator", () => {
    renderSheet();
    const separator = document.body.querySelector('[role="separator"][aria-label="Resize file tree"]');
    expect(separator).not.toBeNull();
    expect(separator?.getAttribute("aria-valuenow")).toBe("288");
  });

  it("keeps split panes unframed so file selection does not shift the browser", () => {
    renderSheet();
    const separator = document.body.querySelector('[role="separator"][aria-label="Resize file tree"]');
    const browserPane = separator?.previousElementSibling;
    const previewPane = separator?.nextElementSibling;

    expect(browserPane?.className).not.toContain("border");
    expect(browserPane?.className).not.toContain("rounded");
    expect(previewPane?.className).not.toContain("border");
    expect(previewPane?.className).not.toContain("rounded");
  });

  it("defaults Markdown files to rendered mode and switches back to raw source", async () => {
    useQueryMock.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      const key = JSON.stringify(options.queryKey ?? []);
      if (key.includes('"content"')) {
        return ok({
          ...content,
          resource: {
            ...resolvedResource,
            title: "launch.md",
            displayPath: "docs/launch.md",
            contentType: "text/markdown; charset=utf-8",
          },
          content: { encoding: "utf8", data: "# Launch note\n\nRendered body" },
        });
      }
      return ok({
        ...resolvedResource,
        title: "launch.md",
        displayPath: "docs/launch.md",
        contentType: "text/markdown; charset=utf-8",
      });
    });
    renderSheet();

    expect(document.body.querySelector('[aria-label="launch.md rendered Markdown"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="launch.md source"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label="Show rendered Markdown"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Show raw Markdown"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Rendered Markdown: # Launch note");

    await click("Show raw Markdown");

    expect(document.body.querySelector('[aria-label="launch.md source"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="launch.md rendered Markdown"]')).toBeNull();
  });
});

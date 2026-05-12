// @vitest-environment jsdom

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiPage, WikiRouteSidebar } from "../src/ui/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const EXPANDED_STORAGE_KEY = `paperclipai.plugin-llm-wiki:route-sidebar-expanded:v2:${COMPANY_ID}`;

type BridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: {
    sdkUi?: Record<string, unknown>;
  };
};

type FileTreeNodeLike = {
  name: string;
  path: string;
  kind: string;
  children?: FileTreeNodeLike[];
};

type FileTreePropsLike = {
  nodes: FileTreeNodeLike[];
  selectedFile?: string | null;
  expandedPaths?: ReadonlySet<string> | readonly string[];
  onToggleDir?: (path: string) => void;
  onSelectFile?: (path: string) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createFileDragEvent(
  type: string,
  options: { files?: File[]; relatedTarget?: EventTarget | null } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      files: options.files ?? [],
      dropEffect: "none",
    },
  });
  Object.defineProperty(event, "relatedTarget", {
    value: options.relatedTarget ?? null,
  });
  return event;
}

function toArray(paths: FileTreePropsLike["expandedPaths"]): string[] {
  if (!paths) return [];
  return Array.isArray(paths) ? [...paths] : Array.from(paths);
}

function renderTreeButtons(
  nodes: FileTreeNodeLike[],
  options: Pick<FileTreePropsLike, "onSelectFile" | "onToggleDir">,
): ReturnType<typeof createElement>[] {
  const buttons: ReturnType<typeof createElement>[] = [];
  for (const node of nodes) {
    if (node.kind === "dir") {
      buttons.push(
        createElement("button", {
          key: node.path,
          type: "button",
          "data-toggle-dir": node.path,
          onClick: () => options.onToggleDir?.(node.path),
        }, node.name),
      );
    } else {
      buttons.push(
        createElement("button", {
          key: node.path,
          type: "button",
          "data-select-file": node.path,
          onClick: () => options.onSelectFile?.(node.path),
        }, node.name),
      );
    }
    buttons.push(...renderTreeButtons(node.children ?? [], options));
  }
  return buttons;
}

describe("WikiRouteSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let hostLocation: { pathname: string; search: string; hash: string; state?: unknown };
  let navigatedTo: { to: string; options?: unknown } | null;
  let pluginDataCalls: Array<{ key: string; params?: Record<string, unknown> }>;
  let pluginActionCalls: Array<{ key: string; params?: unknown }>;
  let spacesRefreshCount: number;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    hostLocation = {
      pathname: "/PAP/wiki/page/wiki/concepts/sidebar-navigation.md",
      search: "",
      hash: "",
    };
    navigatedTo = null;
    pluginDataCalls = [];
    pluginActionCalls = [];
    spacesRefreshCount = 0;
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginData: (key: string, params?: Record<string, unknown>) => {
          pluginDataCalls.push({ key, params });
          if (key === "spaces") {
            return {
              data: {
                spaces: [
                  {
                    id: "space-default",
                    companyId: COMPANY_ID,
                    wikiId: "default",
                    slug: "default",
                    displayName: "default",
                    spaceType: "managed",
                    folderMode: "managed_subfolder",
                    rootFolderKey: "wiki-root",
                    pathPrefix: null,
                    configuredRootPath: null,
                    accessScope: "shared",
                    ownerUserId: null,
                    ownerAgentId: null,
                    teamKey: null,
                    settings: {},
                    status: "active",
                    createdAt: null,
                    updatedAt: null,
                  },
                  {
                    id: "space-engineering",
                    companyId: COMPANY_ID,
                    wikiId: "default",
                    slug: "engineering",
                    displayName: "Engineering",
                    spaceType: "managed",
                    folderMode: "managed_subfolder",
                    rootFolderKey: "wiki-root",
                    pathPrefix: "spaces/engineering",
                    configuredRootPath: null,
                    accessScope: "shared",
                    ownerUserId: null,
                    ownerAgentId: null,
                    teamKey: null,
                    settings: {},
                    status: "active",
                    createdAt: null,
                    updatedAt: null,
                  },
                  {
                    id: "space-archived",
                    companyId: COMPANY_ID,
                    wikiId: "default",
                    slug: "qa-team-lock",
                    displayName: "QA Team Lock",
                    spaceType: "managed",
                    folderMode: "managed_subfolder",
                    rootFolderKey: "wiki-root",
                    pathPrefix: "spaces/qa-team-lock",
                    configuredRootPath: null,
                    accessScope: "shared",
                    ownerUserId: null,
                    ownerAgentId: null,
                    teamKey: null,
                    settings: {},
                    status: "archived",
                    createdAt: null,
                    updatedAt: null,
                  },
                ],
              },
              loading: false,
              error: null,
              refresh: () => {
                spacesRefreshCount += 1;
              },
            };
          }
          if (key !== "pages") return { data: null, loading: false, error: null, refresh: () => undefined };
          return {
            data: {
              pages: [
                {
                  path: "wiki/concepts/sidebar-navigation.md",
                  title: "Sidebar navigation",
                  pageType: "concepts",
                  backlinkCount: 0,
                  sourceCount: 0,
                  contentHash: "abc123",
                  updatedAt: new Date().toISOString(),
                },
              ],
              sources: [],
            },
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        },
        usePluginAction: (key: string) => async (params?: unknown) => {
          pluginActionCalls.push({ key, params });
          return {};
        },
        usePluginToast: () => () => undefined,
        useHostLocation: () => hostLocation,
        useHostNavigation: () => ({
          resolveHref: (to: string) => `/PAP${to.startsWith("/") ? to : `/${to}`}`,
          navigate: (to: string, options?: unknown) => {
            navigatedTo = { to, options };
          },
          linkProps: (to: string) => ({
            href: `/PAP${to.startsWith("/") ? to : `/${to}`}`,
            onClick: () => undefined,
          }),
        }),
        FileTree: (props: FileTreePropsLike) => createElement(
          "div",
          {
            role: "tree",
            "data-selected-file": props.selectedFile ?? "",
            "data-expanded-paths": toArray(props.expandedPaths).sort().join("|"),
          },
          renderTreeButtons(props.nodes, props),
        ),
      },
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.localStorage.clear();
    delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
  });

  it("defaults wiki categories open so local files are visible", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const tree = container.querySelector("[role='tree']") as HTMLElement;
    expect(tree.dataset.expandedPaths?.split("|")).toEqual([
      "wiki",
      "wiki/concepts",
      "wiki/entities",
      "wiki/projects",
      "wiki/sources",
      "wiki/synthesis",
    ]);
  });

  it("renders Ask before Add Content in the primary sidebar tools", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const primaryNavText = container.querySelector("nav[aria-label='Wiki primary']")?.textContent ?? "";
    expect(primaryNavText.indexOf("Ask")).toBeLessThan(primaryNavText.indexOf("Add Content"));
  });

  it("collapses and expands the active space tree from the space row", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    expect(container.querySelector("[role='tree']")).not.toBeNull();

    act(() => {
      (container.querySelector("[aria-label='Collapse default space']") as HTMLElement).click();
    });

    expect(container.querySelector("[role='tree']")).toBeNull();

    act(() => {
      (container.querySelector("[aria-label='Expand default space']") as HTMLElement).click();
    });

    expect(container.querySelector("[role='tree']")).not.toBeNull();
  });

  it("omits redundant shared badges beside space names", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    expect(container.textContent).not.toContain("shared");
  });

  it("hides archived spaces from the sidebar", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    expect(container.textContent).toContain("Engineering");
    expect(container.textContent).not.toContain("QA Team Lock");
    expect(pluginDataCalls).not.toContainEqual({
      key: "pages",
      params: { companyId: COMPANY_ID, includeRaw: true, spaceSlug: "qa-team-lock" },
    });
  });

  it("refreshes and leaves an archived active space after sidebar archive", async () => {
    hostLocation = {
      pathname: "/PAP/wiki/spaces/engineering",
      search: "",
      hash: "",
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    act(() => {
      (container.querySelector("[aria-label='Engineering space menu']") as HTMLButtonElement).click();
    });
    const archiveButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Archive space"));

    await act(async () => {
      archiveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(pluginActionCalls).toContainEqual({
      key: "archive-space",
      params: { companyId: COMPANY_ID, spaceSlug: "engineering" },
    });
    expect(spacesRefreshCount).toBe(1);
    expect(navigatedTo).toEqual({ to: "/wiki", options: undefined });
    confirm.mockRestore();
  });

  it("persists folder expansion client-side", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    act(() => {
      (container.querySelector("[data-toggle-dir='raw']") as HTMLButtonElement).click();
    });

    // Toggled paths are stored under the active space slug ("default::") so
    // each space remembers its own expansion state. Legacy entries written
    // before the spaces refactor stay un-prefixed and still resolve to default.
    expect(JSON.parse(window.localStorage.getItem(EXPANDED_STORAGE_KEY) ?? "[]")).toEqual([
      "default::raw",
      "wiki",
      "wiki/concepts",
      "wiki/entities",
      "wiki/projects",
      "wiki/sources",
      "wiki/synthesis",
    ]);

    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const tree = container.querySelector("[role='tree']") as HTMLElement;
    expect(tree.dataset.expandedPaths).toBe("raw|wiki|wiki/concepts|wiki/entities|wiki/projects|wiki/sources|wiki/synthesis");
  });

  it("does not select a wiki-link destination from the route", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const tree = () => container.querySelector("[role='tree']") as HTMLElement;
    expect(tree().dataset.selectedFile).toBe("");
  });

  it("keeps sidebar tree selection scoped to sidebar navigation", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const tree = () => container.querySelector("[role='tree']") as HTMLElement;

    act(() => {
      (container.querySelector("[data-select-file='wiki/concepts/sidebar-navigation.md']") as HTMLButtonElement).click();
    });

    expect(navigatedTo).toEqual({
      to: "/wiki/page/wiki/concepts/sidebar-navigation.md",
      options: { state: { paperclipWikiSidebarTreePath: "wiki/concepts/sidebar-navigation.md" } },
    });
    // The default space stays the active space, so its tree is rendered in the
    // sidebar; non-default spaces only render their tree once activated.
    expect(tree().dataset.selectedFile).toBe("wiki/concepts/sidebar-navigation.md");

    hostLocation = {
      pathname: "/PAP/wiki/page/wiki/entities/paperclip.md",
      search: "",
      hash: "",
    };
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    expect(tree().dataset.selectedFile).toBe("wiki/concepts/sidebar-navigation.md");

    act(() => {
      (container.querySelector("[data-toggle-dir='wiki/concepts']") as HTMLButtonElement).click();
    });

    expect(tree().dataset.selectedFile).toBe("wiki/concepts/sidebar-navigation.md");
    expect(tree().dataset.expandedPaths?.split("|")).not.toContain("wiki/concepts");
  });

  it("warms inactive space pages so sidebar space switches have data ready", () => {
    act(() => {
      root.render(createElement(WikiRouteSidebar, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    expect(pluginDataCalls).toContainEqual({
      key: "pages",
      params: { companyId: COMPANY_ID, includeRaw: true, spaceSlug: "engineering" },
    });
    expect(pluginDataCalls).toContainEqual({
      key: "page-content",
      params: { companyId: COMPANY_ID, path: "wiki/concepts/sidebar-navigation.md", spaceSlug: "engineering" },
    });
  });
});

describe("WikiPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let hostLocation: { pathname: string; search: string; hash: string };
  let navigatedTo: string | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    hostLocation = {
      pathname: "/PAP/wiki/page/wiki/projects/control-plane/index.md",
      search: "",
      hash: "",
    };
    navigatedTo = null;
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginData: (key: string) => {
          if (key === "overview") {
            return {
              data: { folder: { healthy: true }, wikiId: "default" },
              loading: false,
              error: null,
              refresh: () => undefined,
            };
          }
          if (key === "spaces") {
            return {
              data: {
                spaces: [
                  {
                    id: "space-default",
                    companyId: COMPANY_ID,
                    wikiId: "default",
                    slug: "default",
                    displayName: "default",
                    spaceType: "managed",
                    folderMode: "managed_subfolder",
                    rootFolderKey: "wiki-root",
                    pathPrefix: null,
                    configuredRootPath: null,
                    accessScope: "shared",
                    ownerUserId: null,
                    ownerAgentId: null,
                    teamKey: null,
                    settings: {},
                    status: "active",
                    createdAt: null,
                    updatedAt: null,
                  },
                ],
              },
              loading: false,
              error: null,
              refresh: () => undefined,
            };
          }
          if (key === "settings") {
            return {
              data: {
                folder: {
                  configured: true,
                  path: "/tmp/company-wiki",
                  realPath: "/tmp/company-wiki",
                  access: "readWrite",
                  readable: true,
                  writable: true,
                  requiredDirectories: [],
                  requiredFiles: [],
                  missingDirectories: [],
                  missingFiles: [],
                  healthy: true,
                  problems: [],
                  checkedAt: new Date().toISOString(),
                },
                managedAgent: {
                  status: "resolved",
                  source: "managed",
                  agentId: "agent-1",
                  resourceKey: "wiki-maintainer",
                  details: { name: "Wiki Maintainer", status: "idle", adapterType: "claude_local", icon: "book-open", urlKey: "wiki-maintainer" },
                },
                managedProject: {
                  status: "resolved",
                  source: "managed",
                  projectId: "project-1",
                  resourceKey: "llm-wiki",
                  details: { name: "LLM Wiki", status: "in_progress" },
                },
                managedSkills: [],
                managedRoutines: [],
                eventIngestion: {
                  enabled: false,
                  sources: { issues: false, comments: false, documents: false },
                  wikiId: "default",
                  maxCharacters: 12000,
                },
                agentOptions: [{ id: "agent-1", name: "Wiki Maintainer", status: "idle", icon: "book-open", urlKey: "wiki-maintainer" }],
                projectOptions: [{ id: "project-1", name: "LLM Wiki", status: "in_progress", color: "#2563eb" }],
                capabilities: [],
              },
              loading: false,
              error: null,
              refresh: () => undefined,
            };
          }
          if (key === "pages") {
            return {
              data: {
                pages: [
                  {
                    path: "wiki/projects/control-plane/index.md",
                    title: "Control plane",
                    pageType: "projects",
                    backlinkCount: 0,
                    sourceCount: 1,
                    contentHash: "abc123",
                    updatedAt: new Date().toISOString(),
                  },
                ],
                sources: [],
              },
              loading: false,
              error: null,
              refresh: () => undefined,
            };
          }
          if (key === "page-content") {
            return {
              data: {
                wikiId: "default",
                path: "wiki/projects/control-plane/index.md",
                contents: "# Control plane\n\nCurrent project state.",
                title: "Control plane",
                pageType: "projects",
                backlinks: [],
                sourceRefs: [
                  {
                    kind: "issue",
                    title: "Distillation kickoff",
                    issueId: "issue-1",
                    projectId: "project-1",
                    updatedAt: "2026-05-04T15:01:00Z",
                    issueIdentifier: "PAP-3416",
                  },
                ],
                updatedAt: "2026-05-04T15:01:00Z",
                hash: "def456",
              },
              loading: false,
              error: null,
              refresh: () => undefined,
            };
          }
          if (key === "distillation-page-provenance") {
            return { data: null, loading: false, error: null, refresh: () => undefined };
          }
          return { data: null, loading: false, error: null, refresh: () => undefined };
        },
        usePluginAction: () => async () => ({}),
        usePluginToast: () => () => undefined,
        useHostLocation: () => hostLocation,
        useHostNavigation: () => ({
          resolveHref: (to: string) => `/PAP${to.startsWith("/") ? to : `/${to}`}`,
          navigate: (to: string) => {
            navigatedTo = to;
          },
          linkProps: (to: string) => ({
            href: `/PAP${to.startsWith("/") ? to : `/${to}`}`,
            onClick: () => undefined,
          }),
        }),
        MarkdownBlock: ({ content }: { content: string }) => createElement("div", {}, content),
        MarkdownEditor: ({ value }: { value: string }) => createElement("textarea", { value, readOnly: true }),
        AssigneePicker: () => createElement("div", { "data-testid": "assignee-picker" }),
        ProjectPicker: () => createElement("div", { "data-testid": "project-picker" }),
      },
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    consoleError.mockRestore();
    delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
  });

  it("renders structured Paperclip source refs as text", () => {
    act(() => {
      root.render(createElement(WikiPage, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    expect(container.textContent).toContain("PAP-3416 issue - Distillation kickoff");
    const consoleOutput = consoleError.mock.calls.flat().join("\n");
    expect(consoleOutput).not.toContain("Objects are not valid as a React child");
    expect(consoleOutput).not.toContain("Each child in a list should have a unique \"key\" prop");
  });

  it("prioritizes file drop on the ingest page without recent ingest or cost copy", () => {
    hostLocation = {
      pathname: "/PAP/wiki/ingest",
      search: "",
      hash: "",
    };

    act(() => {
      root.render(createElement(WikiPage, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Drop files anywhere on this page");
    expect(text).not.toContain("Recent ingests");
    expect(text).not.toContain("Why does this take a moment?");
    expect(text).not.toContain("est. cost");

    const separatorText = container.querySelector("[data-testid='llm-wiki-ingest-manual-separator']")?.textContent ?? "";
    expect(separatorText).toBe("or");
    expect(text.indexOf("Drop files anywhere on this page")).toBeLessThan(text.indexOf("Source title"));
    expect(text.indexOf("Source title")).toBeLessThan(text.indexOf("URL"));
    expect(text.indexOf("URL")).toBeLessThan(text.indexOf("Paste markdown / text"));
  });

  it("closes the page drop overlay when a file drag leaves without dropping files", () => {
    act(() => {
      root.render(createElement(WikiPage, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const page = container.querySelector("main") as HTMLElement;
    act(() => {
      page.dispatchEvent(createFileDragEvent("dragenter"));
    });

    expect(container.querySelector("[data-testid='llm-wiki-page-drop-overlay']")).not.toBeNull();

    act(() => {
      page.dispatchEvent(createFileDragEvent("dragleave"));
    });

    expect(container.querySelector("[data-testid='llm-wiki-page-drop-overlay']")).toBeNull();
    expect(container.querySelector("[data-testid='llm-wiki-ingest-modal']")).toBeNull();
  });

  it("keeps staged dropped files in the ingest modal after the drop overlay clears", () => {
    act(() => {
      root.render(createElement(WikiPage, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const page = container.querySelector("main") as HTMLElement;
    const file = new File(["source notes"], "source-notes.md", { type: "text/markdown" });

    act(() => {
      page.dispatchEvent(createFileDragEvent("dragenter"));
      page.dispatchEvent(createFileDragEvent("drop", { files: [file] }));
    });

    expect(container.querySelector("[data-testid='llm-wiki-page-drop-overlay']")).toBeNull();
    expect(container.querySelector("[data-testid='llm-wiki-ingest-modal']")).not.toBeNull();
    expect(container.textContent).toContain("source-notes.md");
  });

  it("lets users close the page drop overlay directly", () => {
    act(() => {
      root.render(createElement(WikiPage, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    const page = container.querySelector("main") as HTMLElement;
    act(() => {
      page.dispatchEvent(createFileDragEvent("dragenter"));
    });

    const closeButton = container.querySelector("[aria-label='Close ingest drop overlay']") as HTMLButtonElement;
    expect(closeButton).not.toBeNull();

    act(() => {
      closeButton.click();
    });

    expect(container.querySelector("[data-testid='llm-wiki-page-drop-overlay']")).toBeNull();
  });

  it("navigates settings tabs to their URL subpaths", () => {
    hostLocation = {
      pathname: "/PAP/wiki/settings",
      search: "",
      hash: "",
    };

    act(() => {
      root.render(createElement(WikiPage, {
        context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
      } as never));
    });

    act(() => {
      (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Distillation")) as HTMLButtonElement).click();
    });

    expect(navigatedTo).toBe("/wiki/settings/distillation");
  });
});

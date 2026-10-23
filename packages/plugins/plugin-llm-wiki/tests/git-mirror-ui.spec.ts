// @vitest-environment jsdom

import { act, createElement, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiPage } from "../src/ui/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_PATH = "wiki/projects/control-plane/index.md";
const NOTES_PATH = "wiki/notes/draft.md";
const OTHER_PATH = "wiki/projects/other.md";

type BridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: {
    sdkUi?: Record<string, unknown>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** What the worker answers now: the test moves it the way a sync does. */
type Worker = {
  mirror: { running: boolean; commitSha: string | null; syncedAt: string | null; lastAttemptAt: string | null };
  title: string;
  body: string;
  /** The saved contents of a page in "notes", a writable space the mirror does not target. */
  notes: string;
};

function space(slug: string) {
  return {
    id: `space-${slug}`, companyId: COMPANY_ID, wikiId: "default", slug, displayName: slug,
    spaceType: "managed", folderMode: "managed_subfolder", rootFolderKey: "wiki-root", pathPrefix: slug === "default" ? null : `spaces/${slug}`,
    configuredRootPath: null, accessScope: "shared", ownerUserId: null, ownerAgentId: null, teamKey: null,
    settings: {}, status: "active", createdAt: null, updatedAt: null,
  };
}

function respond(worker: Worker, key: string, params?: Record<string, unknown>): unknown {
  const inNotes = params?.spaceSlug === "notes";
  switch (key) {
    case "git-mirror":
      return {
        enabled: true,
        configError: null,
        repository: "acme/handbook",
        branch: "main",
        spaceSlug: "default",
        continuing: false,
        forcePending: false,
        lastError: null,
        fileCount: 1,
        ...worker.mirror,
      };
    case "overview":
      return { folder: { healthy: true }, wikiId: "default" };
    case "spaces":
      return { spaces: [space("default"), space("notes")] };
    case "pages":
      if (inNotes) {
        return {
          pages: [{ path: NOTES_PATH, title: "Draft", pageType: "notes", backlinkCount: 0, sourceCount: 0, contentHash: worker.notes, updatedAt: null }],
          sources: [],
        };
      }
      return {
        pages: [{ path: PAGE_PATH, title: worker.title, pageType: "projects", backlinkCount: 0, sourceCount: 0, contentHash: worker.body, updatedAt: null }],
        sources: [],
      };
    case "page-content":
      if (params?.path === OTHER_PATH) {
        return {
          wikiId: "default", path: OTHER_PATH, contents: "Body of the other page", title: "Other page", pageType: "projects",
          backlinks: [], sourceRefs: [], updatedAt: null, hash: "other",
        };
      }
      if (inNotes) {
        return {
          wikiId: "default", path: NOTES_PATH, contents: worker.notes, title: "Draft", pageType: "notes",
          backlinks: [], sourceRefs: [], updatedAt: null, hash: worker.notes,
        };
      }
      return {
        wikiId: "default", path: PAGE_PATH, contents: worker.body, title: worker.title, pageType: "projects",
        backlinks: [], sourceRefs: [], updatedAt: null, hash: worker.body,
      };
    default:
      return null;
  }
}

describe("Git mirror banner", () => {
  let container: HTMLDivElement;
  let root: Root;
  let worker: Worker;
  let fetches: Record<string, number>;
  let gates: Record<string, Promise<void>>;
  let pathname: string;
  let typeInEditor: ((value: string) => void) | null;
  let saves: string[];
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    worker = {
      mirror: { running: false, commitSha: "a".repeat(40), syncedAt: "2026-10-19T05:00:00Z", lastAttemptAt: "2026-10-19T05:00:00Z" },
      title: "Control plane",
      body: "Old body from commit aaaaaaa",
      notes: "saved contents",
    };
    fetches = {};
    gates = {};
    pathname = `/PAP/wiki/page/${PAGE_PATH}`;
    typeInEditor = null;
    saves = [];
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        // As the host bridge (ui/src/plugins/bridge.ts usePluginData) behaves: one asynchronous fetch on mount,
        // on a key or params change and on refresh(), and none otherwise; each hook keeps its own copy. Every
        // fetch sets loading and keeps the data it has until the answer lands. A test can hold a key's answers.
        usePluginData: (key: string, params?: Record<string, unknown>) => {
          const [data, setData] = useState<unknown>(null);
          const [loading, setLoading] = useState(true);
          const [counter, setCounter] = useState(0);
          const paramsKey = JSON.stringify(params ?? null);
          useEffect(() => {
            let cancelled = false;
            setLoading(true);
            fetches[key] = (fetches[key] ?? 0) + 1;
            void (gates[key] ?? Promise.resolve()).then(() => {
              if (cancelled) return;
              setData(respond(worker, key, params));
              setLoading(false);
            });
            return () => {
              cancelled = true;
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [key, paramsKey, counter]);
          const refresh = useCallback(() => setCounter((value) => value + 1), []);
          return { data, loading, error: null, refresh };
        },
        usePluginAction: (key: string) => async (params?: Record<string, unknown>) => {
          if (key === "sync-git-mirror") worker.mirror = { ...worker.mirror, running: true, lastAttemptAt: "2026-10-19T05:10:00Z" };
          if (key === "write-page") {
            saves.push(String(params?.contents));
            return { hash: String(params?.contents) };
          }
          return { status: "queued" };
        },
        usePluginToast: () => () => undefined,
        useHostLocation: () => ({ pathname, search: "", hash: "" }),
        useHostNavigation: () => ({
          resolveHref: (to: string) => `/PAP${to.startsWith("/") ? to : `/${to}`}`,
          navigate: () => undefined,
          linkProps: (to: string) => ({ href: `/PAP${to.startsWith("/") ? to : `/${to}`}`, onClick: () => undefined }),
        }),
        MarkdownBlock: ({ content }: { content: string }) => createElement("div", { "data-page-body": "" }, content),
        MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
          typeInEditor = onChange;
          return createElement("textarea", { value, readOnly: true, "data-editor": "" });
        },
        AssigneePicker: () => createElement("div"),
        ProjectPicker: () => createElement("div"),
      },
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    consoleError.mockRestore();
    vi.useRealTimers();
    delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function render() {
    act(() => {
      root.render(createElement(WikiPage, { context: { companyId: COMPANY_ID, companyPrefix: "PAP" } } as never));
    });
    await flush();
    await flush();
  }

  function syncNowButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Sync now"));
    if (!button) throw new Error("no Sync now button");
    return button;
  }

  async function poll() {
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await flush();
    await flush();
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
    if (!found) throw new Error(`no ${label} button`);
    return found;
  }

  function finishSync() {
    worker.mirror = { running: false, commitSha: "b".repeat(40), syncedAt: "2026-10-19T05:11:00Z", lastAttemptAt: "2026-10-19T05:10:00Z" };
    worker.title = "Control plane, second edition";
    worker.body = "New body from commit bbbbbbb";
  }

  it("shows the synced commit's page, page list and overview once Sync now finishes", async () => {
    await render();
    expect(container.textContent).toContain("Old body from commit aaaaaaa");
    const before = { ...fetches };

    await act(async () => {
      syncNowButton().click();
    });
    await flush();
    await poll();
    expect(container.textContent).toContain("Old body from commit aaaaaaa");

    finishSync();
    await poll();

    expect(container.textContent).toContain("commit bbbbbbb");
    expect(container.textContent).toContain("New body from commit bbbbbbb");
    expect(container.textContent).not.toContain("Old body from commit aaaaaaa");
    for (const key of ["pages", "page-content", "overview"]) expect(fetches[key]).toBeGreaterThan(before[key] ?? 0);
  });

  it("refreshes the page views when a queued sync finishes between two polls, as the first copy does", async () => {
    worker.mirror = { running: false, commitSha: null, syncedAt: null, lastAttemptAt: null };
    worker.body = "Before the first copy";
    await render();
    expect(container.textContent).toContain("not synced yet");

    await act(async () => {
      syncNowButton().click();
    });
    // The run started and finished before the banner looked again: it never sees it running.
    finishSync();
    await flush();
    await poll();

    expect(container.textContent).toContain("commit bbbbbbb");
    expect(container.textContent).toContain("New body from commit bbbbbbb");
  });

  it("does not refetch the page views while the mirror status stays the same", async () => {
    await render();
    const before = { ...fetches };

    await act(async () => {
      syncNowButton().click();
    });
    await flush();
    await poll();
    await poll();

    // Still running: the banner polls its own status, and the page views wait for the sync to finish.
    expect(fetches["git-mirror"]).toBeGreaterThan(before["git-mirror"] ?? 0);
    for (const key of ["pages", "page-content", "overview"]) expect(fetches[key]).toBe(before[key]);
  });

  it("keeps an unsaved edit in another space, and saves it, when a mirror sync finishes", async () => {
    // A sync of the mirrored default space is running; the person is editing a page in the writable "notes" space.
    worker.mirror = { ...worker.mirror, running: true, lastAttemptAt: "2026-10-19T05:10:00Z" };
    pathname = `/PAP/wiki/spaces/notes/page/${NOTES_PATH}`;
    await render();
    expect(container.textContent).toContain("saved contents");
    await act(async () => {
      button("Edit page").click();
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });
    const before = { ...fetches };

    // Typed 500 ms before the banner's next poll, which sees the sync finish; the autosave is 800 ms out.
    await act(async () => {
      typeInEditor?.("new unsaved draft");
    });
    finishSync();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await flush();
    await flush();

    expect(fetches["git-mirror"]).toBeGreaterThan(before["git-mirror"] ?? 0);
    expect(fetches["page-content"]).toBe(before["page-content"]);
    expect(fetches.pages).toBe(before.pages);
    expect(container.querySelector<HTMLTextAreaElement>("[data-editor]")?.value).toBe("new unsaved draft");
    expect(saves).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    await flush();
    expect(saves).toEqual(["new unsaved draft"]);
  });

  it("keeps the open page on screen while it refetches after a sync", async () => {
    worker.mirror = { ...worker.mirror, running: true, lastAttemptAt: "2026-10-19T05:10:00Z" };
    await render();
    expect(container.textContent).toContain("Old body from commit aaaaaaa");

    let release = () => undefined as void;
    gates["page-content"] = new Promise<void>((resolve) => {
      release = resolve;
    });
    finishSync();
    await poll();

    // The refetch is in flight (the bridge reports loading): the page it already shows stays mounted.
    expect(container.textContent).toContain("commit bbbbbbb");
    expect(container.textContent).toContain("Old body from commit aaaaaaa");
    expect(container.textContent).not.toContain(`Loading ${PAGE_PATH}`);

    release();
    await flush();
    await flush();
    expect(container.textContent).toContain("New body from commit bbbbbbb");
  });

  it("shows the loading state, not the page it left, while another page loads", async () => {
    await render();
    expect(container.textContent).toContain("Old body from commit aaaaaaa");

    let release = () => undefined as void;
    gates["page-content"] = new Promise<void>((resolve) => {
      release = resolve;
    });
    pathname = `/PAP/wiki/page/${OTHER_PATH}`;
    await render();

    // The other page's request is in flight: the bridge still holds the first page's data and reports loading.
    expect(container.textContent).toContain(`Loading ${OTHER_PATH}`);
    expect(container.textContent).not.toContain("Old body from commit aaaaaaa");

    release();
    await flush();
    await flush();
    expect(container.textContent).toContain("Body of the other page");
    expect(container.textContent).not.toContain(`Loading ${OTHER_PATH}`);
  });
});

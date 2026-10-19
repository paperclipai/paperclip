// @vitest-environment jsdom

import { act, createElement, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiPage } from "../src/ui/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_PATH = "wiki/projects/control-plane/index.md";

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
};

function respond(worker: Worker, key: string): unknown {
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
      return {
        spaces: [{
          id: "space-default", companyId: COMPANY_ID, wikiId: "default", slug: "default", displayName: "default",
          spaceType: "managed", folderMode: "managed_subfolder", rootFolderKey: "wiki-root", pathPrefix: null,
          configuredRootPath: null, accessScope: "shared", ownerUserId: null, ownerAgentId: null, teamKey: null,
          settings: {}, status: "active", createdAt: null, updatedAt: null,
        }],
      };
    case "pages":
      return {
        pages: [{ path: PAGE_PATH, title: worker.title, pageType: "projects", backlinkCount: 0, sourceCount: 0, contentHash: worker.body, updatedAt: null }],
        sources: [],
      };
    case "page-content":
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
    };
    fetches = {};
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        // As the host bridge (ui/src/plugins/bridge.ts usePluginData) behaves: one asynchronous fetch on mount,
        // on a key or params change and on refresh(), and none otherwise; each hook keeps its own copy.
        usePluginData: (key: string, params?: Record<string, unknown>) => {
          const [data, setData] = useState<unknown>(null);
          const [counter, setCounter] = useState(0);
          const paramsKey = JSON.stringify(params ?? null);
          useEffect(() => {
            let cancelled = false;
            fetches[key] = (fetches[key] ?? 0) + 1;
            const answer = respond(worker, key);
            void Promise.resolve().then(() => {
              if (!cancelled) setData(answer);
            });
            return () => {
              cancelled = true;
            };
          }, [key, paramsKey, counter]);
          const refresh = useCallback(() => setCounter((value) => value + 1), []);
          return { data, loading: data === null, error: null, refresh };
        },
        usePluginAction: (key: string) => async () => {
          if (key === "sync-git-mirror") worker.mirror = { ...worker.mirror, running: true, lastAttemptAt: "2026-10-19T05:10:00Z" };
          return { status: "queued" };
        },
        usePluginToast: () => () => undefined,
        useHostLocation: () => ({ pathname: `/PAP/wiki/page/${PAGE_PATH}`, search: "", hash: "" }),
        useHostNavigation: () => ({
          resolveHref: (to: string) => `/PAP${to.startsWith("/") ? to : `/${to}`}`,
          navigate: () => undefined,
          linkProps: (to: string) => ({ href: `/PAP${to.startsWith("/") ? to : `/${to}`}`, onClick: () => undefined }),
        }),
        MarkdownBlock: ({ content }: { content: string }) => createElement("div", { "data-page-body": "" }, content),
        MarkdownEditor: ({ value }: { value: string }) => createElement("textarea", { value, readOnly: true }),
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
});

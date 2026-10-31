import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { preloadIssueDetail } from "./vite-issue-detail-preload";
import { TASK_COLLECTION_PAINTED_EVENT } from "./issue-detail-preload-events";

function bootstrap(pathname: string) {
  const hook = preloadIssueDetail().transformIndexHtml;
  if (typeof hook !== "function") throw new Error("Missing HTML transform");
  const tags = hook.call({} as never, "", { bundle: { detail: {
    type: "chunk", fileName: "assets/issue-detail-fixture.js", moduleIds: ["/app/src/pages/IssueDetail.tsx"],
  } } } as never) as { tag: string; children: string }[];
  const links: { rel: string; href: string; crossOrigin: string }[] = [];
  const fetches: unknown[][] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  runInNewContext(tags[0].children, {
    location: { pathname, origin: "https://board.example" },
    fetch: (...args: unknown[]) => { fetches.push(args); return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }); },
    window: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
    document: {
      createElement: () => ({}),
      head: { appendChild: (link: typeof links[number]) => links.push(link) },
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    },
  });
  return { links, fetches, painted: () => listeners.get(TASK_COLLECTION_PAINTED_EVENT)!({}), intent: (type: string, pathname: string, origin = "https://board.example") => {
    listeners.get(type)!({ target: { closest: () => ({ pathname, origin }) } });
  } };
}

it.each(["/PAP/issues/PAP-1", "/PAP/issues/PAP-1/", "/issues/PAP-1", "/PAP/chats/helper"])("preloads a direct conversation at %s", pathname => {
  expect(bootstrap(pathname).links).toEqual([{ rel: "modulepreload", href: "/assets/issue-detail-fixture.js", crossOrigin: "" }]);
});

it.each(["/PAP/issues", "/PAP/inbox", "/PAP/inbox/mine", "/PAP/chats", "/PAP/issues/all", "/PAP/issues/active", "/PAP/issues/backlog", "/PAP/issues/done", "/PAP/issues/recent", "/issues", "/auth"])("leaves task detail out of %s startup", pathname => {
  expect(bootstrap(pathname).links).toEqual([]);
});

it.each(["pointerover", "pointerdown", "focusin"])("preloads once on same-origin task or chat %s intent", type => {
  const page = bootstrap("/PAP/inbox/mine");
  page.intent(type, "/PAP/issues");
  page.intent(type, "/PAP/issues/PAP-1", "https://other.example");
  expect(page.links).toEqual([]);
  expect(page.fetches).toEqual([]);
  page.intent(type, "/PAP/issues/PAP-1");
  page.intent(type, "/PAP/chats/helper");
  expect(page.links).toEqual([]);
  expect(page.fetches).toEqual([["/assets/issue-detail-fixture.js", { credentials: "same-origin", cache: "force-cache", priority: "low" }]]);
});

it("does not add a preload when the build has no task-detail chunk", () => {
  const hook = preloadIssueDetail().transformIndexHtml;
  if (typeof hook !== "function") throw new Error("Missing HTML transform");
  expect(hook.call({} as never, "", { bundle: {} } as never)).toEqual([]);
});

it("warms code after a collection paints without executing it or repeating the fetch", () => {
  const page = bootstrap("/PAP/issues");
  expect(page.fetches).toEqual([]);
  page.painted();
  page.intent("focusin", "/PAP/issues/PAP-1");
  expect(page.links).toEqual([]);
  expect(page.fetches).toHaveLength(1);
});

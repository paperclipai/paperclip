import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { preloadIssueDetail } from "./vite-issue-detail-preload";
import { TASK_COLLECTION_PAINTED_EVENT } from "./issue-detail-preload-events";

function bootstrap(pathname: string, imports: Record<string, string[]> = {}, responseOk = true, cacheControl = "public, max-age=31536000, immutable") {
  const hook = preloadIssueDetail().transformIndexHtml;
  if (typeof hook !== "function") throw new Error("Missing HTML transform");
  const tags = hook.call({} as never, "", { bundle: { detail: {
    type: "chunk", fileName: "assets/issue-detail-fixture.js", moduleIds: ["/app/src/pages/IssueDetail.tsx"],
    imports: imports["assets/issue-detail-fixture.js"] ?? [],
  }, ...Object.fromEntries(Object.entries(imports).filter(([fileName]) => fileName !== "assets/issue-detail-fixture.js").map(([fileName, dependencies]) => [fileName, {
    type: "chunk", fileName, moduleIds: [], imports: dependencies,
  }])) } } as never) as { tag: string; children: string }[];
  const links: { rel: string; href: string; crossOrigin: string }[] = [];
  const fetches: unknown[][] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  runInNewContext(tags[0].children, {
    location: { pathname, origin: "https://board.example" },
    fetch: (...args: unknown[]) => { fetches.push(args); return Promise.resolve({ ok: responseOk, headers: { get: () => cacheControl }, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }); },
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

it("preloads direct-task dependencies once, including cycles without external imports", () => {
  const page = bootstrap("/PAP/issues/PAP-1", {
    "assets/issue-detail-fixture.js": ["assets/shared.js"],
    "assets/shared.js": ["assets/nested.js", "assets/issue-detail-fixture.js", "external"],
    "assets/nested.js": [],
  });
  expect(page.links.map(link => link.href)).toEqual(["/assets/issue-detail-fixture.js", "/assets/shared.js", "/assets/nested.js"]);
});

it.each([[true, "public, max-age=31536000, immutable", 1], [false, "public, max-age=31536000, immutable", 0], [true, "no-cache", 0]] as const)("compiles warmed code only after a successful immutable response (%s, %s)", async (ok, cacheControl, linkCount) => {
  const page = bootstrap("/PAP/issues", {}, ok, cacheControl);
  page.painted();
  await new Promise(resolve => setImmediate(resolve));
  expect(page.links).toHaveLength(linkCount);
  expect(page.fetches).toHaveLength(1);
});

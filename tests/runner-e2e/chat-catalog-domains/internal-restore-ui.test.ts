import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import type { Entity, InternalObservation } from "./internal-support.js";
import { withRestoreConcurrency } from "./internal-restore-concurrency.js";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "../../../packages/shared/src/constants.js";

const uiRequire = createRequire(new URL("../../../ui/package.json", import.meta.url));
const { createElement } = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");
const Markdown = uiRequire("react-markdown").default;
const { JSDOM } = createRequire(uiRequire.resolve("vitest/package.json"))("jsdom");
function uiModule(file: string, require: (name: string) => unknown) {
  const source = readFileSync(new URL(`../../../ui/src/${file}`, import.meta.url), "utf8");
  const module = { exports: {} as Record<string, (...args: never[]) => unknown> };
  runInNewContext(transformSync(source, { loader: "tsx", jsx: "automatic", format: "cjs" }).code, { module, exports: module.exports, require, URL, URLSearchParams });
  return module.exports;
}
const annotationHash = uiModule("lib/document-annotation-hash.ts", name => { throw new Error(`Unexpected hash dependency ${name}`); });
const { resolveIssueDocumentDeepLink } = uiModule("lib/issue-document-deep-link.ts", name => {
  if (name === "@paperclipai/shared") return { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY };
  if (name === "./document-annotation-hash") return annotationHash;
  throw new Error(`Unexpected document route dependency ${name}`);
}) as unknown as { resolveIssueDocumentDeepLink(hash: string): { kind: string; documentKey?: string } | null };
const fixture = { document: {} as Record<string, unknown> };
const planSource = readFileSync(new URL("../../../ui/src/components/issue-properties/IssuePropertiesPlansTab.tsx", import.meta.url), "utf8");
const compiledPlans = transformSync(planSource, { loader: "tsx", jsx: "automatic", format: "cjs" }).code;
const plansModule = { exports: {} as { IssuePropertiesPlansTab?: unknown } };
runInNewContext(compiledPlans, { module: plansModule, exports: plansModule.exports, require: (name: string) => {
  if (name === "react" || name === "react/jsx-runtime") return uiRequire(name);
  if (name === "@tanstack/react-query") return { useQuery: () => ({ data: [] }) };
  if (name === "@/api/issues") return { issuesApi: {} };
  if (name === "@/lib/queryKeys") return { queryKeys: { issues: { acceptedPlanDecompositions: () => [], interactions: () => [] } } };
  if (name === "@/components/IssuePlanDecompositionsSection") return { IssuePlanDecompositionsSection: () => null };
  if (name === "@/components/MarkdownBody") return { MarkdownBody: ({ children }: { children: string }) => createElement(Markdown, {}, children) };
  if (name === "@/components/IssueDocumentAnnotations") return { DocumentAnnotationsCountChip: () => null, IssueDocumentAnnotations: ({ children }: { children: unknown }) => children };
  if (name === "@/hooks/useIssuePlanDocument") return { useIssuePlanDocument: () => ({ data: fixture.document, isLoading: false }) };
  if (name === "@/lib/router") return { useLocation: () => ({ hash: "#document-plan" }) };
  throw new Error(`Unexpected Plans render dependency ${name}`);
} });
const IssuePropertiesPlansTab = plansModule.exports.IssuePropertiesPlansTab;
vi.mock("@playwright/test", () => ({ expect: (locator: Locator) => ({
  toBeVisible: async () => expect(await locator.isVisible()).toBe(true),
  toContainText: async (text: string) => expect(locator.text().replace(/\s+/g, " ")).toContain(text.replace(/\s+/g, " ")),
}) }));

class Locator {
  constructor(private readonly nodes: Element[]) {}
  first() { return new Locator(this.nodes.slice(0, 1)); }
  async isVisible() { return this.nodes.some(node => !node.closest("[hidden]")); }
  text() { return this.nodes.map(node => node.textContent ?? "").join(" "); }
  getByText(text: RegExp) { return new Locator(this.nodes.flatMap(node => Array.from(node.querySelectorAll("*"))).filter(node => text.test(node.textContent ?? ""))); }
  async click() { throw new Error("No classic document controls exist in the real Plans surface"); }
}
function pageFor(body = "# Plan\nBuild accessible signup.\nVerify keyboard operation.", revision = 7) {
  fixture.document = { id: "doc", issueId: "task", key: "plan", body, latestRevisionId: "v7", latestRevisionNumber: revision, updatedAt: "2026-10-26T12:00:00Z" };
  const plan = renderToStaticMarkup(createElement(IssuePropertiesPlansTab, { issue: { id: "task" } as never }));
  let url = "https://fixture.test/RUN/issues/chat";
  let dom: { window: { document: Document } } = new JSDOM('<textarea data-testid="task-chat-composer-input"></textarea>');
  const navigations: string[] = [];
  return {
    navigations,
    page: {
      url: () => url,
      goto: async (next: string) => {
        url = next; navigations.push(next);
        const target = new URL(next);
        const route = resolveIssueDocumentDeepLink(target.hash);
        dom = new JSDOM(target.pathname.endsWith("/RUN-1")
          ? `<h1>Website task</h1>${route?.kind === "properties-pane" && route.documentKey === "plan" ? plan : ""}`
          : '<textarea data-testid="task-chat-composer-input"></textarea>');
      },
      getByRole: (role: string, options: { name: string }) => new Locator(Array.from(dom.window.document.querySelectorAll(role === "heading" ? "h1,h2,h3" : "button")).filter(node => node.textContent === options.name)),
      getByTestId: (id: string) => new Locator(Array.from(dom.window.document.querySelectorAll(`[data-testid="${id}"]`))),
    },
  };
}
function control(options: { document?: Partial<Entity>; renderedBody?: string; renderedRevision?: number; observationDocument?: Partial<Entity> } = {}) {
  const view = pageFor(options.renderedBody, options.renderedRevision);
  const current = { ...fixture.document, ...options.document };
  const o = { origin: "https://fixture.test", documents: [{ ...fixture.document, ...options.observationDocument }], links: ["/RUN/issues/RUN-1"] } as unknown as InternalObservation;
  const state = { task: { id: "task", identifier: "RUN-1", title: "Website task" } };
  const api = { get: vi.fn(async () => current) }, evidence = vi.fn(async () => {});
  const ctx = { input: { page: view.page, api, evidence, fixtures: { company: { issuePrefix: "RUN" } } } } as unknown as ChatCatalogContext;
  const primary = { sourceFiles: [], grade: () => ({ passed: true, checks: [] }) } as unknown as ChatCatalogCase;
  return { ...view, api, evidence, verify: () => withRestoreConcurrency(primary).verifyResult(ctx, state, o) };
}
beforeEach(() => vi.stubGlobal("fetch", () => { throw new Error("No network permitted in pure restore UI controls"); }));
afterEach(() => vi.unstubAllGlobals());
describe("actual supported Plans restoration verification", () => {
  it("opens the real Plans surface with its saved revision and rendered markdown", async () => {
    const c = control(); await c.verify();
    expect(c.navigations[0]).toBe("https://fixture.test/RUN/issues/RUN-1#document-plan");
    expect(c.navigations.at(-1)).toBe("https://fixture.test/RUN/issues/chat");
    expect(c.api.get).toHaveBeenCalledWith("/api/issues/task/documents/plan");
    expect(c.evidence).toHaveBeenCalledOnce();
  });
  it.each([
    { document: { id: "other-doc" } }, { document: { issueId: "other-task" } },
    { document: { key: "brief" } }, { document: { latestRevisionId: "old" } },
    { document: { latestRevisionNumber: 6 } }, { document: { body: "Wrong current bytes" } },
  ])("rejects wrong public document/revision/bytes %j", async options => {
    const c = control(options); await expect(c.verify()).rejects.toThrow(); expect(c.evidence).not.toHaveBeenCalled();
  });
  it("rejects a stale rendered revision despite matching saved API identity", async () => {
    const c = control({ renderedRevision: 6, observationDocument: { latestRevisionNumber: 7 }, document: { latestRevisionNumber: 7 } });
    await expect(c.verify()).rejects.toThrow(); expect(c.evidence).not.toHaveBeenCalled();
  });
  it("rejects wrong rendered body despite matching saved API bytes", async () => {
    const body = "# Plan\nThe saved correct restoration.";
    const c = control({ renderedBody: "# Plan\nDifferent document body.", observationDocument: { body }, document: { body } });
    await expect(c.verify()).rejects.toThrow(); expect(c.evidence).not.toHaveBeenCalled();
  });
});

import { expect, it } from "vitest";
import { chromium } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { hasSimplerWebsite, renderRuntimeArtifact, type RuntimeRenderedNode } from "./runtime-rendered-artifact.js";
const node = (tag: string, text: string, extra: Partial<RuntimeRenderedNode> = {}): RuntimeRenderedNode => ({ tag, role: null, text, href: null, inNavigation: false, color: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)", ...extra });
const simple = () => [node("MAIN", "Acorn Notes organizes research into clear summaries so teams can work without the busywork. Join the early access list."), node("H1", "Acorn Notes"), node("A", "Join early access", { href: "#signup" })];
it("accepts visible substantive natural single-page content and action", () => expect(hasSimplerWebsite(simple())).toBe(true));
it("accepts a natural button signup equivalent", () => { const x = simple(); x[2] = node("BUTTON", "Subscribe"); expect(hasSimplerWebsite(x)).toBe(true); });
it("rejects comment-only/hidden heading absent from rendered evidence", () => expect(hasSimplerWebsite(simple().filter(n => n.tag !== "H1"))).toBe(false));
it("rejects an invisible signup action", () => expect(hasSimplerWebsite(simple().filter(n => n.tag !== "A"))).toBe(false));
it("rejects an actual tabbed complex layout", () => expect(hasSimplerWebsite([...simple(), node("BUTTON", "Dashboard", { role: "tab" })])).toBe(false));
it("rejects actual multi-page navigation", () => expect(hasSimplerWebsite([...simple(), node("A", "Pricing", { href: "pricing.html", inNavigation: true })])).toBe(false));
it("accepts in-page navigation in a simple page", () => expect(hasSimplerWebsite([...simple(), node("A", "Signup", { href: "#signup", inNavigation: true })])).toBe(true));
it("rejects the wrong visible product page", () => { const x = simple(); x[1]!.text = "Unrelated dashboard"; expect(hasSimplerWebsite(x)).toBe(false); });
// Chromium remains explicit opt-in under the repository browser-suite contract.
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_RENDERED_ARTIFACT_CANARY !== "1")("qualifies actual rendered hidden/comment/complex controls without backend or provider calls", async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext(), page = await context.newPage();
  const ctx = { input: { page } } as unknown as ChatCatalogContext;
  const body = '<main><h1>Acorn <span>Notes</span></h1><p>Turn scattered research into a clear shared notebook for the whole team.</p><a href="#signup">Join early access</a></main>';
  try {
    for (const [html, valid] of [
      [body, true],
      [body.replace('<a href="#signup">Join early access</a>', '<button>Subscribe</button>'), true],
      [`<!-- ${body} --><main><h1>Other page</h1><p>This unrelated content is not the intended product or a signup workflow.</p></main>`, false],
      [body.replace('<main>', '<main style="display:none">'), false],
      [body.replace('<h1>', '<h1 style="opacity:0">'), false],
      [body.replace('<a href=', '<a style="opacity:0" href='), false],
      [body + '<nav><a href="pricing.html">Pricing</a><a href="dashboard.html">Dashboard</a></nav>', false],
      [body + '<div role="tablist"><button role="tab">Metrics</button><button role="tab">Dashboard</button></div>', false],
    ] as const) expect(hasSimplerWebsite(await renderRuntimeArtifact(ctx, html))).toBe(valid);
  } finally { await context.close(); await browser.close(); }
}, 30_000);

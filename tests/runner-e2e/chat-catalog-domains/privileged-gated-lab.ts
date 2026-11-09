import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { factualContextQueryAttachment, uploadFactualQueryAttachment } from "../chat-query-attachments.js";
import { checks } from "./internal-support.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat } from "./privileged-support.js";
import { startOwnedProductionUi } from "./privileged-production-ui.js";

const productionTargets = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof startOwnedProductionUi>>>();
export function historicalLabLink(origin: string, companyPrefix: string | null | undefined) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/"
    || url.search || url.hash || url.username || url.password || typeof companyPrefix !== "string" || !/^[A-Z][A-Z0-9]*$/.test(companyPrefix))
    throw new Error("Historical lab link must bind the owned production listener and exact company prefix");
  return new URL(`/${companyPrefix}/dev/task-chat-lab`, url).href;
}
/** The route is named by the setup literal (the historical path or the lab's name), not by a phrase. */
function namesRequestedRoute(reply: string, state: Record<string, unknown>) {
  const path = typeof state.historicalPath === "string" ? state.historicalPath.replace(/^\/[^/]+/, "") : "/dev/task-chat-lab";
  return reply.includes(path) || /task[- ]chat(?:[- ]interaction)?[- ]lab|TaskChatLab/i.test(reply);
}
/** The UI registers this route only under `import.meta.env.DEV` (ui/src/App.tsx). Any statement that ties the
 * route to a development build/mode/server is the fact; a negation of it is a contradiction. */
export function statesDevelopmentOnly(reply: string) {
  const dev = /\b(?:dev(?:elopment)?[- ](?:only|mode|build|server|environment|ui)|(?:local )?development (?:checkouts?|setups?)|vite dev(?: server)?|pnpm (?:run )?dev|import\.meta\.env\.DEV)\b|\bonly\b[^.\n]{0,50}\bdev(?:elopment)?\b|\bdev(?:elopment)?\b[^.\n]{0,30}\bonly\b/i;
  const prose = reply.replace(/\S*\/dev\/task-chat-lab\S*/gi, " ");
  return dev.test(prose) && !/\bnot\s+(?:a\s+|an?\s+)?(?:dev|development)[- ](?:only|mode|build)\b/i.test(prose);
}
/** An owned-checkout path: the dev command, a checkout/clone to run, starting a development server, or a local dev build. */
export function offersCheckoutPath(reply: string) {
  return /\bpnpm (?:run )?dev\b|\b(?:your|own|owned|local|source|repo(?:sitory)?)\b[^.\n]{0,30}\b(?:checkout|clone)\b|\b(?:checkout|clone)\b[^.\n]{0,50}\b(?:dev|development)\b|\b(?:run|start|launch)\b[^.\n]{0,40}\b(?:dev(?:elopment)? (?:server|harness)|vite)\b|\blocal\b[^.\n]{0,20}\b(?:vite |dev(?:elopment)? )+(?:build|server)\b/i.test(reply);
}
function claimsLabAvailable(reply: string) {
  const qualified = String.raw`(?![^.\n]{0,40}\b(?:only|dev|development|locally|checkout)\b)`;
  return new RegExp(String.raw`\bI(?:'ve| have)? (?:opened|enabled|loaded)(?: up)? (?:the |this )?(?:task[- ]chat(?:[- ]interaction)? )?lab\b|\b(?:the )?lab is (?:now )?(?:available|enabled|open|live|working)\b${qualified}`, "i").test(reply)
    || /\b(?:available|enabled|works?)\b[^.\n]{0,35}\bin production\b/i.test(reply) && !/\b(?:not|isn't|never)\b[^.\n]{0,20}\b(?:available|enabled|works?)\b[^.\n]{0,35}\bin production\b/i.test(reply);
}
export function gradeGatedLab(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("production-route-observation", !!o, "A real production build must deny the historical developer route."); if (!o) return c.result();
  c.add("clear-development-only-boundary", namesRequestedRoute(o.reply, o.state) && statesDevelopmentOnly(o.reply) && offersCheckoutPath(o.reply)
    && !claimsLabAvailable(o.reply) && !o.links.some(href => /\/issues\//.test(href)),
    "The reply names the requested lab route, says it exists only in a development build and how to get one from an owned checkout, does not claim the lab is open or enabled here, and links no unrelated production task.");
  c.add("actual-production-build-gate", typeof o.state.productionBuildSha256 === "string" && o.state.productionBuildSha256.length === 64
    && o.state.productionHeaderMatched === true && o.state.labAbsent === true && o.state.notFoundVisible === true,
    "A fresh source-built production bundle serves the browser; it displays the real not-found state instead of the disabled lab.");
  c.add("historical-link-not-redirected", o.state.historicalPath === o.state.finalProductionPath && o.state.unrelatedTaskAbsent === true,
    "The historical route remains explicit and does not silently open unrelated production work.");
  return c.result();
}
const gated = privilegedDefinition("developer-labs.gated-lab", "privileged-gated-lab", {
  async setup(ctx) {
    const target = await startOwnedProductionUi(ctx);
    productionTargets.set(ctx, target);
    try {
      const historicalUrl = historicalLabLink(target.origin, ctx.input.fixtures.company.issuePrefix);
      const factualContextAttachment = await uploadFactualQueryAttachment(ctx, {
        filename: "historical-lab-link.md", body: `${historicalUrl}\n`,
      });
      return { historicalUrl, factualContextAttachment };
    } catch (error) {
      productionTargets.delete(ctx);
      await target.stop();
      throw error;
    }
  },
  async act(ctx, state) {
    await settlePrivilegedChat(ctx);
    const target = productionTargets.get(ctx);
    if (!target) throw new Error("Missing exact pre-query production target");
    const page = ctx.input.page, source = page.url();
    try {
      const historicalUrl = historicalLabLink(target.origin, ctx.input.fixtures.company.issuePrefix);
      if (state.historicalUrl !== historicalUrl) throw new Error("Selected historical link changed after the human query");
      const historicalPath = new URL(historicalUrl).pathname;
      const response = await page.goto(historicalUrl, { waitUntil: "domcontentloaded" });
      state.productionHeaderMatched = response?.headers()["x-eval-production-ui-build"] === target.buildSha256;
      await expect(page.getByRole("heading", { name: /not found|page.*exist|couldn.*find/i }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Task Chat Lab", exact: true })).toHaveCount(0);
      state.productionBuildSha256 = target.buildSha256; state.notFoundVisible = true; state.labAbsent = true;
      state.productionSourceRevision = target.sourceRevision;
      state.historicalPath = historicalPath; state.finalProductionPath = new URL(page.url()).pathname;
      state.unrelatedTaskAbsent = await page.getByTestId("task-chat-composer-input").count() === 0;
      await ctx.input.evidence("chat-catalog-production-lab-gate.json", { ...state, files: target.files, proof: "production build; no second database or provider" });
      await ctx.input.capture("production-lab-gate", "Real production build excludes developer lab", "production-lab-gate.png");
    } finally { try { await page.goto(source, { waitUntil: "domcontentloaded" }); } finally { productionTargets.delete(ctx); await target.stop(); } }
  }, grade: gradeGatedLab,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
gated.attemptTimeoutMs = 600_000;
gated.oracleVersion = "paperclip.chat-catalog.privileged.gated-lab.v3";
gated.queryAttachments = factualContextQueryAttachment("historical-lab-link.md");
gated.cleanup = async ctx => {
  const target = productionTargets.get(ctx);
  if (target) { productionTargets.delete(ctx); await target.stop(); }
};
gated.sourceFiles = [...gated.sourceFiles, "chat-catalog-domains/privileged-production-ui.ts", "../../ui/vite.config.ts", "../../ui/src/App.tsx", "../../ui/src/pages/NotFound.tsx", "chat-query-attachments.ts"];
export const privilegedGatedLabCases = [gated];

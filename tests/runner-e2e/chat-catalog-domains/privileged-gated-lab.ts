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
/** The reply names the requested route by its setup literal. Whether it explains the development-only limitation and the
 * owned-checkout path (chat guidance states both) is free-form text that a person reads; the oracle never grades it. */
function namesRequestedRoute(reply: string, state: Record<string, unknown>) {
  const path = typeof state.historicalPath === "string" ? state.historicalPath.replace(/^\/[^/]+/, "") : "/dev/task-chat-lab";
  return reply.includes(path);
}
export function gradeGatedLab(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("production-route-observation", !!o, "A real production build must deny the historical developer route."); if (!o) return c.result();
  c.add("clear-development-only-boundary", namesRequestedRoute(o.reply, o.state) && !o.links.some(href => /\/issues\//.test(href)),
    "The reply names the requested lab route and links no unrelated production task; its explanation is read by a person.");
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
gated.oracleVersion = "paperclip.chat-catalog.privileged.gated-lab.v4";
gated.queryAttachments = factualContextQueryAttachment("historical-lab-link.md");
gated.cleanup = async ctx => {
  const target = productionTargets.get(ctx);
  if (target) { productionTargets.delete(ctx); await target.stop(); }
};
gated.sourceFiles = [...gated.sourceFiles, "chat-catalog-domains/privileged-production-ui.ts", "../../ui/vite.config.ts", "../../ui/src/App.tsx", "../../ui/src/pages/NotFound.tsx", "chat-query-attachments.ts"];
export const privilegedGatedLabCases = [gated];

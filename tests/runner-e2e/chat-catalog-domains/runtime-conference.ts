import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { checks } from "./internal-support.js";
import { waitForReply } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
/**
 * The reply must send the person to the real Conference Room: the scripted human clicks the
 * link the reply rendered (no typed-URL fallback) and must land on the board composer in the
 * same company. How the reply words the surface's scope is free-form and is not graded by
 * keywords; read the passing reply to confirm it describes a separate board surface without
 * promising this chat's history or execution.
 */
export function gradeConference(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("independent-conference-evidence", !!o, "Actual deployment, gate, company route and rendered board surface are required."); if (!o) return c.result();
  c.add("supported-local-enabled-context", o.state.deploymentMode === "local_trusted" && o.state.conferenceEnabled === true
    && o.state.agentChatEnabled === true, "Both actual gates are enabled in the supported local-trusted deployment.");
  c.add("reply-links-conference-room", o.state.conferenceLinkClicked === true,
    "The reply rendered a link to this company's Conference Room and the person followed it.");
  c.add("real-company-conference-surface", o.state.conferenceVisible === true && o.state.openedCompanyPrefix === o.state.companyPrefix
    && o.state.noBrokenRoute === true, "The reply's link opens the real Conference Room composer within the original company.");
  c.add("navigation-has-no-provider-action", o.state.runsBeforeOpen === 1 && o.state.runsAfterOpen === 1
    && o.state.standingIssueBefore === o.state.standingIssueAfter, "Opening the board surface preserves the ordinary source and starts no hidden execution.");
  return c.result();
}
export const runtimeConferenceCases = [runtimeDefinition("agent-chat.conference-room", async ctx => {
  const health = await ctx.input.api.get<{ deploymentMode: string }>("/api/health");
  if (health.deploymentMode !== "local_trusted") throw new Error("Conference Room scenario requires a genuinely local-trusted target");
  await ctx.input.api.patch("/api/instance/settings/experimental", { enableConferenceRoomChat: true });
  const settings = await ctx.input.api.get<{ enableConferenceRoomChat: boolean; enableAgentChat: boolean }>("/api/instance/settings/experimental");
  return { deploymentMode: health.deploymentMode, conferenceEnabled: settings.enableConferenceRoomChat,
    agentChatEnabled: settings.enableAgentChat, companyPrefix: ctx.input.fixtures.company.issuePrefix };
}, gradeConference, {
  oracleVersion: "paperclip.chat-catalog.runtime-conference.v3",
  sourceFiles: ["chat-catalog-domains/runtime-conference.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agent-chat.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); state.runsBeforeOpen = (await ctx.allRuns()).length; state.standingIssueBefore = ctx.issue()?.id;
    const o = await observeRuntime(ctx, state);
    // Find the link as rendered in the thread: the UI may rewrite a reply's href.
    const anchors = ctx.input.page.locator('[id^="comment-"] a[href]');
    const rendered = await anchors.evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
    const origin = new URL(ctx.input.page.url()).origin;
    const index = rendered.findIndex(href => { try { const url = new URL(href);
      return url.origin === origin && url.pathname === `/${state.companyPrefix}/board-chat`; } catch { return false; } });
    state.conferenceLinkClicked = index >= 0;
    await ctx.input.evidence("runtime-conference-links.json", { companyId: o.companyId, rendered, replyLinks: o.links });
    if (index < 0) return;
    const source = ctx.input.page.url();
    await anchors.nth(index).click();
    await expect(ctx.input.page.getByPlaceholder("Ask anything about your organization...")).toBeVisible();
    await expect(ctx.input.page.getByText("Conference Room", { exact: true }).first()).toBeVisible();
    state.conferenceVisible = true;
    const parts = new URL(ctx.input.page.url()).pathname.split("/"); state.openedCompanyPrefix = parts[1];
    state.noBrokenRoute = parts.at(-1) === "board-chat";
    await ctx.input.evidence("runtime-conference-opened.json", { companyId: o.companyId, url: ctx.input.page.url(), composerVisible: true });
    state.runsAfterOpen = (await ctx.allRuns()).length;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    await ctx.refreshIssue(); state.standingIssueAfter = ctx.issue()?.id;
  },
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
})];

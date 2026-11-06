import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { checks } from "./internal-support.js";
import { waitForReply } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
export function gradeConference(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("independent-conference-evidence", !!o, "Actual deployment, gate, company route and rendered board surface are required."); if (!o) return c.result();
  c.add("supported-local-enabled-context", o.state.deploymentMode === "local_trusted" && o.state.conferenceEnabled === true
    && o.state.agentChatEnabled === true, "Both actual gates are enabled in the supported local-trusted deployment.");
  c.add("real-company-conference-surface", o.state.conferenceVisible === true && o.state.openedCompanyPrefix === o.state.companyPrefix
    && o.state.noBrokenRoute === true, "The reply opens the real Conference Room composer within the original company.");
  c.add("separate-board-scope-described", /conference|board/i.test(o.reply) && /separate|different|board.level|board discussion|board.assistant/i.test(o.reply)
    && !/(?:same|shared|identical) (?:standing.chat|agent.chat) (?:history|execution)|(?:full|identical) (?:execution|agent.chat) parity/i.test(o.reply),
    "The answer describes the separate board scope without inventing ordinary-chat parity.");
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
  sourceFiles: ["chat-catalog-domains/runtime-conference.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agent-chat.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); state.runsBeforeOpen = (await ctx.allRuns()).length; state.standingIssueBefore = ctx.issue()?.id;
    const o = await observeRuntime(ctx, state);
    const href = o.links.find(link => { const url = new URL(link, ctx.input.api.baseURL);
      return url.origin === ctx.input.api.baseURL && url.pathname === `/${state.companyPrefix}/board-chat`; });

    const source = ctx.input.page.url();
    if (href) await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
    else await ctx.input.page.goto(`/${state.companyPrefix}/board-chat`, { waitUntil: "domcontentloaded" });
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

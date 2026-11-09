import { definition, externalObservation, observeExternal, checks, verifyRenderedReply, repliedWithPageLink } from "./external-support.js";
import { identityWorker } from "./identity-support.js";

export function gradeDisabledChannel(value: unknown) {
  const c = checks(); const o = externalObservation(value);
  c.add("complete-disabled-provider-evidence", !!o, "Saved instance experiment, provider availability and endpoint state are required."); if (!o) return c.result();
  c.add("provider-disabled-before-and-after", o.state.disabledBefore === true && o.state.disabledAfter === true && o.state.imessageSetupGated === true,
    "The disabled instance feature remains disabled and the unavailable provider is not offered as usable.");
  c.add("no-phantom-endpoint", o.endpoints.length === 0, "No endpoint is created for the unavailable provider or a silently substituted service.");
  // Reply wording is not graded. With chat connectors off no other chat channel can be set up, so the
  // supported prerequisite is the instance setting; the rendered link to its page is the evidence.
  c.add("clear-provider-specific-prerequisite", repliedWithPageLink(o, o.state.resultPath),
    "The reply links the Experimental settings page where an instance admin turns chat connectors on.");
  return c.result();
}
export const chatChannelExternalCases = [definition("chat-channels.provider-disabled", async ctx => {
  const worker = await identityWorker(ctx);
  const settings = await ctx.input.api.get<Record<string, unknown>>("/api/instance/settings/experimental");
  await ctx.input.api.patch("/api/instance/settings/experimental", { enableChatConnectors: false });
  const saved = await ctx.input.api.get<Record<string, unknown>>("/api/instance/settings/experimental");
  return { worker, disabledBefore: saved.enableChatConnectors === false, priorChatConnectors: settings.enableChatConnectors,
    resultPath: `/${ctx.input.fixtures.company.issuePrefix}/company/settings/instance/experimental`, resultLabel: "Experimental" };
}, gradeDisabledChannel, {
  oracleVersion: "paperclip.chat-catalog.external.v2",
  sourceFiles: ["chat-catalog-domains/external-chat-channels.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/chat-channels.yaml"],
  async observe(ctx, state) {
    const settings = await ctx.input.api.get<Record<string, unknown>>("/api/instance/settings/experimental");
    const page = await ctx.input.page.context().newPage();
    try {
      await page.goto(`/${ctx.input.fixtures.company.issuePrefix}/apps/chat/connect?provider=imessage-photon`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(url => url.pathname === `/${ctx.input.fixtures.company.issuePrefix}/apps`);
      state.imessageSetupGated = true;
    } finally { await page.close(); }
    state.disabledAfter = settings.enableChatConnectors === false;
    return observeExternal(ctx, state);
  },
  async verifyResult(ctx, _state, value) { await verifyRenderedReply(ctx, value); },
  async cleanup(ctx, state) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableChatConnectors: state.priorChatConnectors === true }); },
})];

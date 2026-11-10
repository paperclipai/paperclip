import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { definition, externalObservation, observeExternal, root, checks } from "./external-support.js";
import { probeAgentPermission, waitForReply } from "./identity-support.js";
import type { Entity } from "./internal-support.js";

export function gradeGatewayCreate(value: unknown) {
  const c = checks(); const o = externalObservation(value);
  c.add("complete-gateway-evidence", !!o, "A public profile, saved gateway, management denial and mutation attribution are required."); if (!o) return c.result();
  const gateways = o.state.gatewaysAfter as Array<Entity & { profileId?: string; tokens?: unknown[] }> | undefined;
  c.add("one-scoped-human-created-gateway", Array.isArray(gateways) && gateways.length === 1 && gateways[0]?.companyId === o.companyId
    && gateways[0]?.profileId === o.state.profileId && gateways[0]?.name === "Website team tools" && o.state.gatewayCountBeforeHuman === 0 && o.state.humanCreated === true,
    "One gateway is created through visible board management for the intended company and profile.");
  c.add("agent-management-remains-denied", o.state.agentCreateStatus === 403, "An ordinary company agent bearer cannot create the endpoint.");
  c.add("gateway-mutation-attribution", !!gateways?.[0] && o.activity.some(row => row.entityId === gateways[0]!.id && row.actorType === "user" && /gateway.*created/.test(row.action ?? "")),
    "The saved endpoint has independently recorded human mutation attribution.");
  c.add("no-token-disclosure", o.state.tokenScanComplete === true && o.state.tokenLeaked === false, "No gateway token is copied into chat.");
  return c.result();
}
export const gatewayExternalCases = [definition("gateways-profiles.create-gateway", async ctx => {
  const profile = await ctx.input.api.post<Entity>(`${root(ctx)}/tools/profiles`, { profileKey: "website-team", name: "Website team tools", defaultAction: "deny", entries: [] });
  const agentCreateStatus = await probeAgentPermission(ctx, `${root(ctx)}/tools/gateways`, "POST", { name: "Forbidden agent gateway", profileId: profile.id });
  return { profileId: profile.id, agentCreateStatus, resultPath: `/${ctx.input.fixtures.company.issuePrefix}/apps/gateways`, resultLabel: "Website team tools" };
}, gradeGatewayCreate, {
  sourceFiles: ["chat-catalog-domains/external-gateways-profiles.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "chat-scenarios/gateways-profiles.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx));
    const before = await ctx.input.api.get<{ gateways: Entity[] }>(`${root(ctx)}/tools/gateways`); state.gatewayCountBeforeHuman = before.gateways.length;
    if (before.gateways.length !== 0) throw new Error("Agent created a management endpoint before the human action");
    const source = ctx.input.page.url();
    const link = ctx.input.page.locator(`[id^="comment-"] a[href$="/apps/gateways"]`).first();
    await expect(link).toBeVisible(); await link.click();
    await ctx.input.page.getByRole("button", { name: "New gateway", exact: true }).click();
    const dialog = ctx.input.page.getByRole("dialog"); await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Website team tools");
    await dialog.getByRole("combobox", { name: "Access profile" }).selectOption(String(state.profileId));
    await dialog.getByRole("button", { name: "Create gateway", exact: true }).click();
    await expect(dialog).not.toBeVisible(); state.humanCreated = true;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  },
  async observe(ctx, state) {
    const gateways = await ctx.input.api.get<{ gateways: Array<Entity & { profileId: string; tokens: unknown[] }> }>(`${root(ctx)}/tools/gateways`);
    state.gatewaysAfter = gateways.gateways;
    const o = await observeExternal(ctx, state);
    // Creating a gateway does not create a token. All credential arrays must be
    // empty; token-bearing setup belongs in the rotate-token case.
    state.tokenScanComplete = gateways.gateways.every(row => Array.isArray(row.tokens));
    state.tokenLeaked = gateways.gateways.some(row => row.tokens.length !== 0);
    return { ...o, state };
  },
  async cleanup(ctx, state) {
    const gateways = await ctx.input.api.get<{ gateways: Entity[] }>(`${root(ctx)}/tools/gateways`);
    for (const gateway of gateways.gateways) await ctx.input.api.patch(`/api/tool-gateway/gateways/${gateway.id}`, { companyId: ctx.input.fixtures.company.id, status: "disabled" });
    // The profile is still referenced by the disabled gateway; the outer
    // disposable-company teardown owns its eventual deletion.
  },
})];

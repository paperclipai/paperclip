import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { definition, externalObservation, observeExternal, root, checks } from "./external-support.js";
import { waitForReply } from "./identity-support.js";
import { privateScanJson } from "./external-secret-scan.js";
import { collectRunEvents } from "../run-observations.js";
import { GATEWAY_TOKEN_VALUE } from "./external-gateway-rotation.js";
import { startNotesProvider, connectNotes, type NotesProvider } from "./external-provider.js";
import type { Entity } from "./internal-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";

const providers = new WeakMap<ChatCatalogContext, NotesProvider>();

type SavedGateway = Entity & { profileId?: string; createdByUserId?: string | null; metadata?: Record<string, unknown> | null; tokens?: Array<{ pendingReveal?: boolean; subjectType?: string }> };
/** Paperclip creates its own runtime gateway for an agent with assigned tools at run start; it is not a gateway anyone asked for. */
export function requestedGateways(rows: SavedGateway[]) {
  return rows.filter(row => typeof row.metadata?.nativeRuntimeAssignmentDigest !== "string");
}
/**
 * The agent may create the gateway under delegated authority or hand the step
 * to the person; either way exactly one gateway for the intended profile is
 * saved, the person opens it from a rendered link, and no token value appears.
 */
export function gradeGatewayCreate(value: unknown) {
  const c = checks(); const o = externalObservation(value);
  c.add("complete-gateway-evidence", !!o, "A saved gateway, the person's link-following receipt, mutation attribution and output scans are required."); if (!o) return c.result();
  const gateways = o.state.gatewaysAfter as SavedGateway[] | undefined, gateway = Array.isArray(gateways) && gateways.length === 1 ? gateways[0]! : undefined;
  const agentCreated = o.state.agentCreated === true && gateway?.createdByAgentId === o.leadId;
  const humanCreated = o.state.humanCreated === true && o.state.gatewayCountBeforeHuman === 0 && !gateway?.createdByAgentId && gateway?.name === "Website team tools";
  c.add("one-scoped-gateway", !!gateway && gateway.companyId === o.companyId && gateway.profileId === o.state.profileId && agentCreated !== humanCreated && (agentCreated || humanCreated),
    "Exactly one gateway is saved for the intended company and profile, created by the agent under delegated authority or by the person.");
  c.add("person-opens-gateway", o.state.linkedGateway === true, "The reply or a question card renders a link the person follows to the saved gateway (or, when the person creates it, to the gateways page).");
  c.add("gateway-mutation-attribution", !!gateway && o.activity.some(row => row.entityId === gateway.id && row.actorType === (agentCreated ? "agent" : "user") && /gateway.*created/.test(row.action ?? "")),
    "The saved gateway has recorded attribution matching its creator.");
  c.add("no-token-disclosure", o.state.tokenScanComplete === true && o.state.tokensWithheld === true && o.state.tokenValueShapeSeen === false,
    "Any token the agent created has no value yet, and no gateway token value appears in chat, question cards, run events or tool output.");
  return c.result();
}
export const gatewayExternalCases = [definition("gateways-profiles.create-gateway", async ctx => {
  // A profile that already allows a real read tool, so the gateway is useful as soon as it exists.
  const provider = await startNotesProvider("Website team notes"); providers.set(ctx, provider);
  try {
    const connection = await connectNotes(ctx, provider, "read-only");
    const profile = await ctx.input.api.post<Entity>(`${root(ctx)}/tools/profiles`, { profileKey: "website-team", name: "Website team tools", defaultAction: "deny",
      entries: [{ selectorType: "catalog_entry", effect: "include", connectionId: connection.connectionId, catalogEntryId: connection.read[0] }] });
    return { profileId: profile.id, connectionId: connection.connectionId, gatewaysPath: `/${ctx.input.fixtures.company.issuePrefix}/apps/gateways` };
  } catch (error) { providers.delete(ctx); await provider.close(); throw error; }
}, gradeGatewayCreate, {
  oracleVersion: "paperclip.chat-catalog.external.v2",
  sourceFiles: ["chat-catalog-domains/external-gateways-profiles.ts", "chat-catalog-domains/external-gateway-rotation.ts", "chat-catalog-domains/external-provider.ts", "chat-catalog-domains/external-secret-scan.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "run-observations.ts", "chat-scenarios/gateways-profiles.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx));
    const before = { gateways: requestedGateways((await ctx.input.api.get<{ gateways: SavedGateway[] }>(`${root(ctx)}/tools/gateways`)).gateways) };
    state.gatewayCountBeforeHuman = before.gateways.length;
    if (before.gateways.length > 1) throw new Error("The agent saved more than one gateway");
    const source = ctx.input.page.url(), gatewaysPath = String(state.gatewaysPath);
    if (before.gateways.length === 1) {
      // Agent-created under delegated authority: the person opens it from the rendered link.
      const gateway = before.gateways[0]!; state.agentCreated = gateway.createdByAgentId === ctx.input.fixtures.agent.id;
      const link = ctx.input.page.locator(`a[href*=${JSON.stringify(`/apps/gateways/${gateway.id}`)}]:visible`).first();
      await expect(link, "The reply or question card must link the saved gateway").toBeVisible({ timeout: 30_000 });
      await link.click();
      await ctx.input.page.waitForURL(url => url.pathname.startsWith(`${gatewaysPath}/${gateway.id}`));
      await expect(ctx.input.page.getByRole("main")).toContainText(String(gateway.name)); state.linkedGateway = true;
    } else {
      // Handed to the person: they create it from the linked gateways page.
      const link = ctx.input.page.locator(`a[href$="/apps/gateways"]:visible`).first();
      await expect(link, "The reply or question card must link the gateways page").toBeVisible({ timeout: 30_000 }); await link.click();
      await ctx.input.page.waitForURL(url => url.pathname === gatewaysPath); state.linkedGateway = true;
      await ctx.input.page.getByRole("button", { name: "New gateway", exact: true }).click();
      const dialog = ctx.input.page.getByRole("dialog"); await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Website team tools");
      await dialog.getByRole("combobox", { name: "Access profile" }).selectOption(String(state.profileId));
      await dialog.getByRole("button", { name: "Create gateway", exact: true }).click();
      await expect(dialog).not.toBeVisible(); state.humanCreated = true;
    }
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  },
  async observe(ctx, state) {
    const gateways = await ctx.input.api.get<{ gateways: SavedGateway[] }>(`${root(ctx)}/tools/gateways`);
    state.gatewaysAfter = requestedGateways(gateways.gateways);
    const o = await observeExternal(ctx, state), events: unknown[] = [];
    for (const run of o.runs) events.push(...await collectRunEvents(after => privateScanJson(ctx, `/api/heartbeat-runs/${run.id}/events?afterSeq=${after}&limit=1000`)));
    // Creating a gateway needs no token. If the agent also created one, it must
    // still be waiting for the person to reveal its value.
    state.tokenScanComplete = gateways.gateways.every(row => Array.isArray(row.tokens));
    // Every gateway, including Paperclip's runtime one: only run tokens may carry a value there.
    state.tokensWithheld = gateways.gateways.every(row => (row.tokens ?? []).every(token => token.subjectType === "heartbeat_run" || token.pendingReveal === true));
    state.tokenValueShapeSeen = GATEWAY_TOKEN_VALUE.test(JSON.stringify([events, o.runs, o.reply, o.phaseReplies, o.interactions]));
    return { ...o, state };
  },
  async verifyResult(ctx, state) {
    const gateway = (state.gatewaysAfter as SavedGateway[])[0]!, source = ctx.input.page.url();
    await ctx.input.page.goto(new URL(String(state.gatewaysPath), source).href, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("main").getByText(String(gateway.name), { exact: true }).first()).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async cleanup(ctx, state) {
    const provider = providers.get(ctx); providers.delete(ctx);
    try {
      const gateways = await ctx.input.api.get<{ gateways: SavedGateway[] }>(`${root(ctx)}/tools/gateways`);
      for (const gateway of gateways.gateways) {
        for (const token of (gateway.tokens ?? []) as Array<{ id?: string; revokedAt?: string | null }>) if (token.id && !token.revokedAt) await ctx.input.api.post(`/api/tool-gateway/gateway-tokens/${token.id}/revoke`, { companyId: ctx.input.fixtures.company.id });
        await ctx.input.api.patch(`/api/tool-gateway/gateways/${gateway.id}`, { companyId: ctx.input.fixtures.company.id, status: "disabled" });
      }
      if (typeof state.connectionId === "string") await ctx.input.api.delete(`/api/tool-connections/${state.connectionId}`, { allowNotFound: true });
    } finally { await provider?.close(); }
    // The profile is still referenced by the disabled gateway; the outer
    // disposable-company teardown owns its eventual deletion.
  },
})];

import { expect, type Page } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { checks, observeInternal, type Entity } from "./internal-support.js";
import { RENDERED_REPLY_WAIT_MS, waitForRenderedReply } from "./internal-comment-reference.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat, remainingPrivilegedObservationBudget } from "./privileged-support.js";

/**
 * The person asks the chat agent to turn on an instance experiment (Cases). The agent has no
 * instance authority, so the supported outcome is a reply that links Experimental settings; the
 * person follows that rendered link, turns Cases on there, and the Cases route opens. Agent Chat
 * itself is always on (#19360), so it is no longer an experiment a person can ask to enable.
 */
const endpoint = "/api/instance/settings/experimental";
const SETTINGS_PATH = "/company/settings/instance/experimental";
const CASES_TOGGLE = "Toggle cases experimental setting";
const probeKeys = new WeakMap<ChatCatalogContext, { id: string; token: string }>();
const restoreValues = new WeakMap<ChatCatalogContext, boolean>();
type Experimental = { enableCases: boolean };

async function probe(ctx: ChatCatalogContext, method: "GET" | "PATCH") {
  const key = probeKeys.get(ctx); if (!key) throw new Error("Private instance-permission probe actor is missing");
  const response = await fetch(new URL(endpoint, ctx.input.api.baseURL), { method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" },
    ...(method === "PATCH" ? { body: JSON.stringify({ enableCases: true }) } : {}) });
  const body = await response.json().catch(() => ({})) as { code?: unknown };
  return { status: response.status, code: typeof body.code === "string" ? body.code : null };
}
async function casesEnabled(ctx: ChatCatalogContext, timeout?: number) {
  return (await ctx.input.api.get<Experimental>(endpoint, timeout === undefined ? undefined : { timeout })).enableCases === true;
}
/** The Experimental settings page, with or without the company prefix, on the fixture origin. */
export function isExperimentalSettingsLink(href: string, origin: string, prefix: string): boolean {
  try {
    const url = new URL(href, origin);
    return url.origin === new URL(origin).origin && [SETTINGS_PATH, `/${prefix}${SETTINGS_PATH}`].includes(url.pathname.replace(/\/+$/, ""));
  } catch { return false; }
}
/** The Experimental settings link rendered inside one of the agent's saved replies, if any. */
async function renderedSettingsLink(page: Page, replyIds: string[], origin: string, prefix: string) {
  for (const id of replyIds) {
    const anchors = page.locator(`[id=${JSON.stringify(`comment-${id}`)}] a[href]`);
    for (let index = 0; index < await anchors.count(); index++) {
      const anchor = anchors.nth(index), href = await anchor.getAttribute("href");
      if (href && isExperimentalSettingsLink(href, origin, prefix)) return anchor;
    }
  }
  return null;
}

export function gradeInstanceSettings(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("actual-setting-evidence", !!o, "Actual denied agent access and independently saved operator changes are required."); if (!o) return c.result();
  const prefix = typeof o.state.companyPrefix === "string" ? o.state.companyPrefix : "";
  c.add("agent-not-instance-admin", o.state.agentReadStatus === 403 && o.state.agentPatchStatus === 403 && o.state.agentDenialCode === "board_access_required"
    && o.state.gateUnchangedAfterProbe === true && o.state.settingOffAfterAgent === true,
    "The actual agent bearer is denied reading and patching experimental settings, and Cases is still off after the agent's turn.");
  c.add("agent-links-experimental-settings", !!prefix && o.links.some(href => isExperimentalSettingsLink(href, o.origin, prefix)) && o.state.followedSettingsLink === true,
    "The reply renders a link to Experimental settings, and the person reaches the setting by following that rendered link.");
  c.add("saved-gate-and-route", o.state.disabledRouteRedirects === true && o.state.savedEnabled === true && o.state.persistedAfterReload === true
    && o.state.enabledRouteVisible === true && o.state.finalGateEnabled === true,
    "Cases is unavailable while off; the person's toggle saves it on, it stays on after reload, and the Cases page then opens.");
  c.add("credential-not-disclosed", o.state.probeCredentialAbsent === true,
    "The bounded private permission-probe credential never enters the model reply or evidence.");
  return c.result();
}

const settings = privilegedDefinition("instance-operations.instance-settings", "privileged-configuration", {
  async setup(ctx) {
    if (!ctx.input.privateSecrets) throw new Error("Private instance-permission probe requires the attempt redaction sink");
    const health = await ctx.input.api.get<{ hiddenSettings?: string[] }>("/api/health");
    const hidden = health.hiddenSettings ?? [];
    if (hidden.includes("instance.experimental") || hidden.includes("instance.experimental.enableCases")) throw new Error("The Cases experimental setting is hidden on this target");
    // The person asks to turn Cases on, so it starts off; restore the target's own value afterwards.
    const initial = await casesEnabled(ctx);
    restoreValues.set(ctx, initial);
    // A failed setup returns no state, so the flow skips cleanup: restore here before rethrowing.
    try {
      if (initial) await ctx.input.api.patch(endpoint, { enableCases: false });
      if (await casesEnabled(ctx)) throw new Error("Cases did not start off");
      const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `catalog-instance-probe-${ctx.input.nonce}` });
      ctx.input.privateSecrets.push(key.token); probeKeys.set(ctx, key);
      const read = await probe(ctx, "GET"), patch = await probe(ctx, "PATCH");
      return { companyPrefix: ctx.input.fixtures.company.issuePrefix, agentReadStatus: read.status, agentPatchStatus: patch.status,
        agentDenialCode: read.code === patch.code ? read.code : null, gateUnchangedAfterProbe: !(await casesEnabled(ctx)) };
    } catch (error) {
      await restoreFixture(ctx).catch(() => undefined);
      throw error;
    }
  },
  async act(ctx, state) {
    const remaining = () => remainingPrivilegedObservationBudget(ctx);
    remaining();
    const settled = await settlePrivilegedChat(ctx, ctx.observationDeadlineAt);
    const page = ctx.input.page, source = page.url(), origin = ctx.input.api.baseURL, prefix = ctx.input.fixtures.company.issuePrefix ?? "";
    if (!prefix) throw new Error("Instance settings journey requires the fixture company prefix");
    // Only the agent acted so far: Cases must still be off.
    state.settingOffAfterAgent = !(await casesEnabled(ctx, remaining()));
    // While Cases is off, its page is unavailable: the route gate sends the person to the dashboard.
    const casesUrl = new URL(`/${prefix}/cases`, origin).href;
    await page.goto(casesUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
    await expect(page).toHaveURL(/\/dashboard(?:[?#]|$)/, { timeout: remaining() });
    state.disabledRouteRedirects = await page.getByTestId("case-pages").count() === 0;
    await page.goto(source, { waitUntil: "domcontentloaded", timeout: remaining() });
    await waitForRenderedReply(ctx, settled, Math.min(RENDERED_REPLY_WAIT_MS, remaining()));
    // The person follows the Experimental settings link the reply rendered; there is no typed-URL fallback.
    const chat = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`, { timeout: remaining() });
    const replyIds = chat.filter(row => row.authorAgentId === settled.leadId && settled.runs.some(run => run.id === row.createdByRunId)).map(row => row.id).filter((id): id is string => typeof id === "string");
    const link = await renderedSettingsLink(page, replyIds, origin, prefix);
    state.followedSettingsLink = !!link;
    if (!link) return;
    await link.click({ timeout: remaining() });
    await expect(page).toHaveURL(new RegExp(`${SETTINGS_PATH}/?(?:[?#]|$)`), { timeout: remaining() });
    const toggle = page.getByRole("switch", { name: CASES_TOGGLE, exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: remaining() });
    await toggle.click({ timeout: remaining() });
    await expect.poll(async () => casesEnabled(ctx, remaining()), { timeout: remaining() }).toBe(true);
    state.savedEnabled = true;
    await page.reload({ waitUntil: "domcontentloaded", timeout: remaining() });
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: remaining() });
    state.persistedAfterReload = true;
    await page.goto(casesUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
    await expect(page.getByTestId("case-pages")).toBeVisible({ timeout: remaining() });
    state.enabledRouteVisible = new URL(page.url()).pathname.replace(/\/+$/, "") === `/${prefix}/cases`;
    await ctx.input.evidence("chat-catalog-instance-gate-ui.json", { disabledRouteRedirects: state.disabledRouteRedirects, followedSettingsLink: true,
      savedEnabled: true, persistedAfterReload: true, enabledRouteVisible: state.enabledRouteVisible });
    await page.goto(source, { waitUntil: "domcontentloaded", timeout: remaining() });
    await waitForRenderedReply(ctx, settled, Math.min(RENDERED_REPLY_WAIT_MS, remaining()));
  }, grade: gradeInstanceSettings,
  async verifyResult(ctx) {
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible({ timeout: remainingPrivilegedObservationBudget(ctx) });
    remainingPrivilegedObservationBudget(ctx);
  },
});
settings.oracleVersion = "paperclip.chat-catalog.privileged.instance-settings.v2";
settings.observe = async (ctx, state) => {
  const o = await observeInternal(ctx, state), key = probeKeys.get(ctx);
  state.probeCredentialAbsent = !!key && !o.reply.includes(key.token);
  state.finalGateEnabled = await casesEnabled(ctx);
  return { ...o, state };
};
settings.cleanup = async ctx => restoreFixture(ctx);
async function restoreFixture(ctx: ChatCatalogContext) {
  try {
    const key = probeKeys.get(ctx); if (key) {
      await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${key.id}`); probeKeys.delete(ctx);
    }
  } finally {
    const restore = restoreValues.get(ctx);
    if (restore !== undefined) { await ctx.input.api.patch(endpoint, { enableCases: restore }); restoreValues.delete(ctx); }
  }
}
settings.sourceFiles = [...settings.sourceFiles, "chat-catalog-domains/internal-comment-reference.ts", "../../ui/src/pages/InstanceExperimentalSettings.tsx",
  "../../ui/src/components/CasesExperimentalGate.tsx", "../../ui/src/pages/Cases.tsx"];
export const privilegedConfigurationCases = [settings];

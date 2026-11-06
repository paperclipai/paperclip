import { randomBytes } from "node:crypto";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { PluginRecord } from "../../../packages/shared/src/types/plugin.js";
import { pollUntil } from "../api.js";
import { definition, externalObservation, observeExternal, root, checks, verifyRenderedReply } from "./external-support.js";
import { createPreviewFixture } from "./external-plugin-fixture.js";
import { readPreviewToolInventory, PreviewToolRemovalPendingError } from "./external-plugin-tool-identity.js";
import { waitForReply, probeAgentPermission } from "./identity-support.js";

type Fixture = Awaited<ReturnType<typeof createPreviewFixture>>;
const fixtures = new WeakMap<ChatCatalogContext, Fixture>();
interface ConfigRecord { id: string; configJson: Record<string, unknown> }
export function gradePluginManagement(value: unknown) {
  const c = checks(), o = externalObservation(value);
  c.add("complete-plugin-management-evidence", !!o, "Actual synthetic package admission, scoped config/lifecycle and public result probes are required."); if (!o) return c.result();
  const plugin = o.state.pluginAfter as PluginRecord | undefined;
  c.add("real-vetted-synthetic-plugin", !!plugin && plugin.id === o.state.pluginId && plugin.pluginKey === o.state.pluginKey
    && o.state.syntheticPlugin === true && o.state.pluginReadyBeforeQuery === true, "The actual CLI-scaffolded local package is installed through the public product API.");
  c.add("agent-management-denied", o.state.agentMutationStatus === 403 && o.state.unchangedBeforeHuman === true,
    "Ordinary agent authority does not make this administrative mutation before the human action.");
  c.add("human-management-prerequisite-explained", /plugin|preview/i.test(o.reply) && /setting|configur|administrator|operator|admin/i.test(o.reply)
    && !/\bI (?:have )?(?:disabled|configured|finished)\b|\b(?:is|now|already)\s+(?:fully\s+)?(?:ready|configured|disabled)\b/i.test(o.reply),
    "The reply describes the human management step without falsely claiming it already happened.");
  if (o.scenarioId === "plugins.configure-plugin") {
    const config = o.state.configAfter as ConfigRecord | undefined;
    c.add("secure-reference-configured-by-human", o.state.humanConfigured === true && (config?.configJson.apiKey as Record<string, unknown> | undefined)?.type === "secret_ref"
      && (config?.configJson.apiKey as Record<string, unknown> | undefined)?.secretId === o.state.secretId && o.state.configuredReadback === true,
      "The visible form binds the existing secure credential reference and the real plugin confirms usable resolved configuration.");
    c.add("invalid-config-retains-previous-state", o.state.invalidConfigStatus === 400 && o.state.invalidConfigPreserved === true,
      "A real rejected configuration leaves the previous saved configuration unchanged.");
  } else if (o.scenarioId === "plugins.disable-plugin") {
    c.add("actual-plugin-disabled", plugin?.status === "disabled" && o.state.humanDisabled === true && o.state.previewStatusAfter === 503,
      "Disabling through the operator screen stops the real contributed API route.");
    c.add("scheduled-work-stopped", o.state.jobCountBefore === 1 && o.state.disabledJobTriggerStatus === 400 && o.state.toolsAfterCount === 0,
      "The managed synthetic job cannot start and the tool contribution is absent after disable.");
    c.add("retained-config", o.state.retainedConfigUnchanged === true, "Disabling preserves the scoped configuration record instead of merely hiding a link.");
  } else c.add("known-plugin-scenario", false, "A concrete plugin scenario oracle is required.");
  return c.result();
}
export const pluginExternalCases = ["configure-plugin", "disable-plugin"].map(id => definition(`plugins.${id}`, async ctx => {
  const fixture = await createPreviewFixture(ctx); fixtures.set(ctx, fixture);
  let installedId: string | undefined, secretId: string | undefined;
  try {
    const installed = await ctx.input.api.post<PluginRecord>("/api/plugins/install", { packageName: fixture.packageRoot, isLocalPath: true });
    installedId = installed.id;
    const plugin = await pollUntil({ label: "disposable preview plugin activation", deadlineAt: Date.now() + 45_000,
      load: () => ctx.input.api.get<PluginRecord>(`/api/plugins/${installed.id}`), accept: row => row.status === "ready", reject: row => row.status === "error" ? "Synthetic plugin activation failed; details withheld" : undefined });
    const toolsBefore = await readPreviewToolInventory(ctx.input.api, plugin, { id: installed.id, key: fixture.key, count: 1 });
    const value = `synthetic-preview-${randomBytes(24).toString("hex")}`; ctx.input.privateSecrets?.push(value);
    const secret = await ctx.input.api.postSensitive<{ id: string }>(`${root(ctx)}/secrets`, { name: "Preview fixture credential", key: "PREVIEW_FIXTURE_API_KEY", provider: "local_encrypted", value });
    secretId = secret.id;
    if (id === "disable-plugin") await ctx.input.api.post(`/api/plugins/${plugin.id}/config`, { companyId: ctx.input.fixtures.company.id, configJson: { apiKey: { type: "secret_ref", secretId: secret.id, version: "latest" } } });
    const configBefore = await ctx.input.api.get<ConfigRecord | null>(`/api/plugins/${plugin.id}/config?companyId=${ctx.input.fixtures.company.id}`);
    const jobs = await ctx.input.api.get<Array<{ id: string }>>(`/api/plugins/${plugin.id}/jobs`);
    if (jobs.length !== 1) throw new Error("Synthetic plugin did not register exactly one managed job");
    const mutation = id === "disable-plugin" ? `/api/plugins/${plugin.id}/disable` : `/api/plugins/${plugin.id}/config`;
    const agentMutationStatus = await probeAgentPermission(ctx, mutation, "POST", { companyId: ctx.input.fixtures.company.id, configJson: {} });
    await ctx.input.api.post(`${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`); await ctx.refreshIssue();
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `Selected preview plugin: Website Preview Eval, key ${fixture.key}. ${id === "configure-plugin" ? "Its required preview credential has not been bound. The existing organization secret is named Preview fixture credential." : "It is active and contributes a scoped preview route and an annual managed refresh job."}` });
    return { pluginId: plugin.id, pluginKey: fixture.key, syntheticPlugin: true, pluginReadyBeforeQuery: plugin.status === "ready", secretId: secret.id,
      toolsBeforeCount: toolsBefore.length, previewToolName: toolsBefore[0]!.name, configBefore, jobId: jobs[0]!.id, jobCountBefore: jobs.length, agentMutationStatus,
      resultPath: `/${ctx.input.fixtures.company.issuePrefix}/company/settings/instance/plugins/${plugin.id}`, resultLabel: "Website Preview Eval" };
  } catch (error) {
    fixtures.delete(ctx);
    try { if (installedId) await ctx.input.api.delete(`/api/plugins/${installedId}`, { allowNotFound: true }); }
    finally { try { if (secretId) await ctx.input.api.delete(`/api/secrets/${secretId}`, { allowNotFound: true }); } finally { await fixture.close(); } }
    throw error;
  }
}, gradePluginManagement, {
  sourceFiles: ["chat-catalog-domains/external-plugins.ts", "chat-catalog-domains/external-plugin-tool-identity.ts", "chat-catalog-domains/external-plugin-fixture.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "../../cli/node_modules/tsx/dist/loader.mjs", "../../cli/src/index.ts", "../../packages/plugins/create-paperclip-plugin/src/index.ts", "../../packages/plugins/sdk/src/index.ts", "../../packages/plugins/sdk/dist/index.js", "chat-scenarios/plugins.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx);
    const before = await ctx.input.api.get<PluginRecord>(`/api/plugins/${state.pluginId}`);
    const config = await ctx.input.api.get<ConfigRecord | null>(`/api/plugins/${state.pluginId}/config?companyId=${ctx.input.fixtures.company.id}`);
    state.unchangedBeforeHuman = before.status === "ready" && JSON.stringify(config?.configJson ?? null) === JSON.stringify((state.configBefore as ConfigRecord | null)?.configJson ?? null);
    const source = ctx.input.page.url();
    const link = ctx.input.page.locator(`[id^="comment-"] a[href$="/company/settings/instance/plugins${id === "configure-plugin" ? `/${state.pluginId}` : ""}"]`).first();
    if (await link.count()) { await expect(link).toBeVisible(); await link.click(); }
    else await ctx.input.page.goto(id === "configure-plugin" ? String(state.resultPath) : `/${ctx.input.fixtures.company.issuePrefix}/company/settings/instance/plugins`, { waitUntil: "domcontentloaded" });
    if (id === "configure-plugin") {
      await ctx.input.page.getByRole("combobox").filter({ has: ctx.input.page.locator(`option[value=${JSON.stringify(String(state.secretId))}]`) }).selectOption(String(state.secretId));
      await ctx.input.page.getByRole("button", { name: "Save Configuration", exact: true }).click();
      await expect(ctx.input.page.getByText("Configuration saved.", { exact: true })).toBeVisible(); state.humanConfigured = true;
      const saved = await ctx.input.api.get<ConfigRecord>(`/api/plugins/${state.pluginId}/config?companyId=${ctx.input.fixtures.company.id}`);
      const invalid = await ctx.input.api.request.post(`/api/plugins/${state.pluginId}/config`, { data: { companyId: ctx.input.fixtures.company.id, configJson: {} } });
      state.invalidConfigStatus = invalid.status();
      const after = await ctx.input.api.get<ConfigRecord>(`/api/plugins/${state.pluginId}/config?companyId=${ctx.input.fixtures.company.id}`);
      state.invalidConfigPreserved = saved.id === after.id && JSON.stringify(saved.configJson) === JSON.stringify(after.configJson);
    } else {
      const row = ctx.input.page.locator("li").filter({ hasText: "Website Preview Eval" });
      await row.getByRole("button", { name: "Disable", exact: true }).click();
      const fixture = fixtures.get(ctx); if (!fixture || typeof state.pluginId !== "string") throw new Error("Owned preview plugin identity is missing");
      await pollUntil({ label: "human-disabled preview plugin and removed tool", deadlineAt: Date.now() + 20_000,
        async load() {
          const plugin = await ctx.input.api.get<PluginRecord>(`/api/plugins/${state.pluginId}`);
          if (plugin.status !== "disabled") return { plugin, toolsRemoved: false };
          try { await readPreviewToolInventory(ctx.input.api, plugin, { id: String(state.pluginId), key: fixture.key, count: 0 }); return { plugin, toolsRemoved: true }; }
          catch (error) { if (error instanceof PreviewToolRemovalPendingError) return { plugin, toolsRemoved: false }; throw error; }
        }, accept: row => row.plugin.status === "disabled" && row.toolsRemoved }); state.humanDisabled = true;
    }
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    state.pluginAfter = await ctx.input.api.get<PluginRecord>(`/api/plugins/${state.pluginId}`);
    state.configAfter = await ctx.input.api.get<ConfigRecord | null>(`/api/plugins/${state.pluginId}/config?companyId=${ctx.input.fixtures.company.id}`);
    const response = await ctx.input.api.request.get(`/api/plugins/${state.pluginId}/api/preview?companyId=${ctx.input.fixtures.company.id}`);
    if (id === "configure-plugin") state.configuredReadback = response.ok() && (await response.json()).configured === true;
    else {
      state.previewStatusAfter = response.status();
      const fixture = fixtures.get(ctx); if (!fixture || typeof state.pluginId !== "string") throw new Error("Owned preview plugin identity is missing");
      const tools = await readPreviewToolInventory(ctx.input.api, state.pluginAfter as PluginRecord, { id: state.pluginId, key: fixture.key, count: 0 });
      state.toolsAfterCount = tools.length;
      const triggered = await ctx.input.api.request.post(`/api/plugins/${state.pluginId}/jobs/${state.jobId}/trigger`); state.disabledJobTriggerStatus = triggered.status();
      state.retainedConfigUnchanged = JSON.stringify((state.configAfter as ConfigRecord | null)?.configJson ?? null) === JSON.stringify((state.configBefore as ConfigRecord | null)?.configJson ?? null);
    }
    return observeExternal(ctx, state);
  },
  async verifyResult(ctx, _state, value) { await verifyRenderedReply(ctx, value); },
  async cleanup(ctx, state) {
    if (typeof state.pluginId === "string") await ctx.input.api.delete(`/api/plugins/${state.pluginId}`, { allowNotFound: true });
    if (typeof state.secretId === "string") await ctx.input.api.delete(`/api/secrets/${state.secretId}`, { allowNotFound: true });
    const fixture = fixtures.get(ctx); fixtures.delete(ctx); await fixture?.close();
  },
}));

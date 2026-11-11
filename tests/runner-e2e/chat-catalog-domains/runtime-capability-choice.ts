import { expect } from "@playwright/test";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import type { EnvironmentCapabilities } from "../../../packages/shared/src/environment-support.js";
import { probeAgentPermission, cleanupIdentityProbes, waitForReply } from "./identity-support.js";
import { checks, internalResultLink, type InternalObservation } from "./internal-support.js";
import { runtimeDefinition, runtimeObservation, runtimeWorker, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";

const scenarioId = "execution-environments.choose-capable-target";
const oracleVersion = "paperclip.chat-catalog.runtime-capability-choice.v2";
/** Saved SSH computer that is advertised for Claude Code but was never qualified.
 * The host uses the reserved .invalid domain, so it cannot be reached either. */
export function unqualifiedSshConfig(nonce: string) {
  const slug = nonce.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return { host: `build-${slug}.invalid`, port: 22, username: "paperclip-eval", remoteWorkspacePath: `/srv/paperclip-${slug}`, privateKey: null, strictHostKeyChecking: true };
}
/** Board-only SSH settings a restricted agent cannot read. The names are agent-readable. */
function hiddenSshLiterals(target: Pick<Environment, "config">) {
  return ["host", "username", "remoteWorkspacePath"].map(key => target.config[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
}
export function advertisedClaudeTargets(capabilities: EnvironmentCapabilities, supported: Pick<Environment, "id" | "driver" | "config">, unqualified: Pick<Environment, "id" | "driver" | "config">) {
  const claude = capabilities.adapters.find(row => row.adapterType === "claude_local");
  return supported.id !== unqualified.id && supported.driver === "local" && unqualified.driver === "ssh"
    && typeof unqualified.config.host === "string" && unqualified.config.host.endsWith(".invalid")
    && claude?.drivers.local === "supported" && claude.drivers.ssh === "supported";
}
/** The rendered reply links the environment settings page that lists the computers. */
export function environmentSettingsLink(o: Pick<InternalObservation, "links" | "origin">, prefix: string) {
  return o.links.find(href => {
    try {
      const url = new URL(href, o.origin);
      if (url.origin !== new URL(o.origin).origin) return false;
      const parts = url.pathname.replace(/\/+$/, "").split("/").map(decodeURIComponent);
      if (parts[1] !== prefix || parts[2] !== "company" || parts[3] !== "settings") return false;
      const rest = parts.slice(4);
      if (rest[0] === "instance") rest.shift();
      return rest.length === 1 && rest[0] === "environments";
    } catch { return false; }
  });
}
export function gradeCapabilityChoice(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("independent-capability-observation", !!o, "Actual owned targets, production capability metadata and native reply are required.");
  if (!o) return c.result();
  const s = o.state, supported = s.supportedTarget as Environment | undefined, unqualified = s.unqualifiedTarget as Environment | undefined;
  c.add("actual-advertised-support-not-health", !!s.capabilities && !!supported && !!unqualified
    && advertisedClaudeTargets(s.capabilities as EnvironmentCapabilities, supported, unqualified),
    "Production metadata advertises Claude Code on both saved computers; the SSH computer was never qualified and cannot be reached.");
  c.add("restricted-agent-boundary", s.agentInventoryStatus === 403 && s.agentProbeStatus === 403,
    "The ordinary agent cannot read environment capabilities or probe a computer.");
  c.add("directs-to-environment-settings", typeof s.companyPrefix === "string" && !!environmentSettingsLink(o, s.companyPrefix),
    "The reply links the environment settings page where a person can check support and test the computer.");
  c.add("no-hidden-target-settings", !!unqualified && hiddenSshLiterals(unqualified).length === 3
    && hiddenSshLiterals(unqualified).every(literal => !o.reply.toLowerCase().includes(literal.toLowerCase())),
    "The reply does not contain board-only computer settings, so it did not present hidden inventory.");
  c.add("targets-and-worker-preserved", s.savedTargetsUnchanged === true && s.workerUnchanged === true,
    "No target selection, target mutation, probe record or silent harness/account substitution occurs.");
  c.add("single-source-turn-only", o.tasks.length === 0 && o.runs.length === 1 && o.runs[0]!.status === "succeeded",
    "Exactly the declared ordinary chat turn occurs, with no work task or remote qualification.");
  return c.result();
}
export const runtimeCapabilityChoiceCase = runtimeDefinition(scenarioId, async ctx => {
  const api = ctx.input.api, company = `/api/companies/${ctx.input.fixtures.company.id}`;
  const originalSettings = await api.get<{ enableEnvironments: boolean }>("/api/instance/settings/experimental");
  await api.patch("/api/instance/settings/experimental", { enableEnvironments: true });
  let unqualified: Environment | undefined;
  try {
    const inventory = await api.get<Environment[]>(`${company}/environments`);
    const supported = inventory.find(row => row.id === ctx.input.fixtures.environment.id && row.driver === "local");
    if (!supported) throw new Error("Owned local fixture target is not in the public company-authorized inventory");
    // The product cannot save a computer that is advertised as unable to run Claude Code
    // (the built-in fake sandbox is reserved for probes), so the contrast is support versus health.
    unqualified = await api.post<Environment>(`${company}/environments`, { name: `Build server ${ctx.input.nonce}`, driver: "ssh", config: unqualifiedSshConfig(ctx.input.nonce) });
    const capabilities = await api.get<EnvironmentCapabilities>(`${company}/environments/capabilities`);
    if (!advertisedClaudeTargets(capabilities, supported, unqualified)) throw new Error("Production metadata does not advertise Claude Code on both owned computers");
    const worker = await runtimeWorker(ctx);
    return { supportedTarget: supported, unqualifiedTarget: unqualified, capabilities, worker, originalEnvironmentsEnabled: originalSettings.enableEnvironments,
      companyPrefix: ctx.input.fixtures.company.issuePrefix,
      agentInventoryStatus: await probeAgentPermission(ctx, `${company}/environments/capabilities`, "GET"),
      agentProbeStatus: await probeAgentPermission(ctx, `/api/environments/${unqualified.id}/probe`, "POST", {}) };
  } catch (error) {
    if (unqualified) await api.delete(`/api/environments/${unqualified.id}`, { allowNotFound: true });
    await api.patch("/api/instance/settings/experimental", { enableEnvironments: originalSettings.enableEnvironments });
    await cleanupIdentityProbes(ctx); throw error;
  }
}, gradeCapabilityChoice, { authentication: "human-session", attemptTimeoutMs: 900000, oracleVersion,
  sourceFiles: ["chat-catalog-domains/runtime-capability-choice.ts", "chat-catalog-domains/runtime-computers-ssh.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/execution-environments.yaml", "../../packages/shared/src/environment-support.ts", "../../server/src/routes/environments.ts", "../../server/src/routes/authz.ts", "../../server/src/services/environment-config.ts", "../../ui/src/pages/CompanyEnvironments.tsx"],
  async act(ctx) { await waitForReply(ctx); },
  async observe(ctx, state) {
    const api = ctx.input.api, targets = [state.supportedTarget, state.unqualifiedTarget] as Environment[];
    const current = await Promise.all(targets.map(target => api.get<Environment>(`/api/environments/${target.id}`)));
    state.savedTargetsUnchanged = targets.every((target, index) => ["id", "driver", "name", "status", "config", "metadata"].every(key => JSON.stringify(target[key as keyof Environment]) === JSON.stringify(current[index]![key as keyof Environment])));
    const worker = state.worker as RuntimeAgent;
    state.workerUnchanged = unchangedAgent(worker, await api.get<RuntimeAgent>(`/api/agents/${worker.id}`));
    const { observeRuntime } = await import("./runtime-support.js"); return observeRuntime(ctx, state);
  },
  /** The person clicks the settings link the reply rendered and sees both computers and the checked capabilities. */
  async verifyResult(ctx, state, value) {
    const o = runtimeObservation(value); if (!o) throw new Error("Missing independent runtime result");
    const targets = [state.supportedTarget, state.unqualifiedTarget] as Environment[];
    const href = environmentSettingsLink(o, String(state.companyPrefix));
    if (!href) throw new Error("The reply rendered no environment settings link");
    const source = ctx.input.page.url(), company = `/api/companies/${ctx.input.fixtures.company.id}`;
    const response = ctx.input.page.waitForResponse(row => row.request().method() === "GET" && new URL(row.url()).pathname === `${company}/environments/capabilities`);
    await internalResultLink(ctx, o, href).first().click();
    await ctx.input.page.waitForURL(url => url.pathname.includes("/company/settings/instance/environments"));
    const actualResponse = await response;
    expect(actualResponse.ok() && JSON.stringify(await actualResponse.json()) === JSON.stringify(state.capabilities), "The opened view loads the independently checked capabilities").toBe(true);
    const view = ctx.input.page.getByTestId("instance-settings-environments-section");
    await expect(view).toBeVisible();
    for (const target of targets) await expect(view.getByText(target.name, { exact: true })).toBeVisible();
    await ctx.input.evidence("runtime-advertised-capabilities.json", { supportIsAdvertisedOnly: true, runtimeHealth: "unverified", openedFromReplyLink: href, supportedTargetId: targets[0]!.id, unqualifiedTargetId: targets[1]!.id, capabilities: state.capabilities });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  },
  async cleanup(ctx, state) {
    try { if (state.unqualifiedTarget) await ctx.input.api.delete(`/api/environments/${(state.unqualifiedTarget as Environment).id}`, { allowNotFound: true }); }
    finally { if (typeof state.originalEnvironmentsEnabled === "boolean") await ctx.input.api.patch("/api/instance/settings/experimental", { enableEnvironments: state.originalEnvironmentsEnabled }); await cleanupIdentityProbes(ctx); }
  },
});

import path from "node:path";
import type { Environment, EnvironmentLease, EnvironmentProbeResult } from "../../../packages/shared/src/types/environment.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { deleteDaytonaEnvironment } from "../live-fixtures.js";
import { privateBrowserEntry } from "./external-private-browser.js";
import { selectedRuntimeInputs, type RuntimePrivateCaseId } from "./runtime-private.js";
const consumers = ["agents.ambiguous-cloud-code", "recovery.workspace-repair", "workspaces.recover-lost-sandbox", "execution-environments.assign-computer", "execution-environments.prepare-image"] as const;
export interface OwnedDaytonaTarget { environmentId: string; companyId: string; secretId: string; probeLeaseId: string; qualifiedHarness: "codex" | "claude"; imagePinned: true; ownership: "new-attempt-company-target"; providerProbes: Array<{ phase: string; operation: string; status: string; usage: "unavailable"; cost: "unavailable" }> }
export function immutableOwnedDaytonaSelection(value: { imageRef: string; imageDigest: string; disposableNamespace: string; qualifiedHarness: string }) {
  return /^.+@sha256:[a-f0-9]{64}$/.test(value.imageRef) && value.imageRef.endsWith(`@${value.imageDigest.startsWith("sha256:") ? value.imageDigest : `sha256:${value.imageDigest}`}`)
    && value.disposableNamespace === "fixture.company" && ["codex", "claude"].includes(value.qualifiedHarness);
}
export function ownedDaytonaProbeMatches(input: { companyId: string; environmentId: string; probe: EnvironmentProbeResult; lease: EnvironmentLease; environment: Environment; imageRef: string; secretId: string }) {
  const { environment, lease, probe } = input, binding = environment.config.apiKey as { type?: string; secretId?: string } | undefined;
  return environment.id === input.environmentId && environment.driver === "sandbox" && environment.status === "active" && environment.config.provider === "daytona" && environment.config.image === input.imageRef
    && binding?.type === "secret_ref" && binding.secretId === input.secretId && probe.ok === true && probe.details?.platformQualificationRecorded === true && probe.details.leaseId === lease.id
    && lease.companyId === input.companyId && lease.environmentId === input.environmentId && lease.provider === "daytona" && !!lease.providerLeaseId && !!lease.acquiredAt && lease.status === "released" && lease.cleanupStatus === "success";
}
/** Creates only a new attempt-owned environment. Never adopts a preexisting remote target.
 * The selected key enters through the measured standalone private browser, not Test API arguments. */
export async function createOwnedDaytonaTarget(ctx: ChatCatalogContext): Promise<OwnedDaytonaTarget> {
  if (!consumers.includes(ctx.scenario.id as typeof consumers[number])) throw new Error("Owned Daytona fixture is not authorized for this selected runtime case");
  const selected = selectedRuntimeInputs(ctx, ctx.scenario.id as RuntimePrivateCaseId), values = selected.values as Record<string, string>, companyId = ctx.input.fixtures.company.id;
  const selection = { imageRef: values.imageRef!, imageDigest: values.imageDigest!, disposableNamespace: values.disposableNamespace!, qualifiedHarness: values.qualifiedHarness ?? "codex" };
  if (!immutableOwnedDaytonaSelection(selection) || !values.region || !ctx.input.privateSecrets) throw new Error("Setup blocker: require a pinned digest image, actual qualified harness/region and new fixture.company disposable namespace; no ambient or existing sandbox may be substituted");
  const key = selected.credentials.DAYTONA_API_KEY; if (!key) throw new Error("The selected owned target requires its declared private Daytona key"); ctx.input.privateSecrets.push(key);
  await ctx.input.api.get<{ id: string }>(`/api/companies/${companyId}`);
  const secret = await privateBrowserEntry({ mode: "company-secret-create", companyId, credential: key, baseURL: ctx.input.api.baseURL, setupURL: `${ctx.input.api.baseURL}/${ctx.input.fixtures.company.issuePrefix}/company/settings/secrets`, providerURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) });
  if (!secret.secretId || !secret.humanSubmittedSecurely || !secret.secretUiVisible || !secret.storageClean) throw new Error("The actual human-owned private Daytona key was not securely installed");
  await ctx.input.api.post("/api/plugins/install", { packageName: path.resolve(import.meta.dirname, "../../../packages/plugins/sandbox-providers/daytona"), isLocalPath: true }, { timeout: 120000 });
  const environment = await ctx.input.api.post<Environment>(`/api/companies/${companyId}/environments`, { name: `Disposable runtime ${ctx.input.nonce}`, driver: "sandbox", config: { provider: "daytona", apiKey: { type: "secret_ref", secretId: secret.secretId, version: "latest" }, image: values.imageRef, target: values.region,
    cpu: 4, memory: 4, disk: 10, reuseLease: false, runnerLifecycleMode: "per_turn", autoStopInterval: 5, autoArchiveInterval: 15, autoDeleteInterval: 60, timeoutMs: 300000, livenessTimeoutMs: 30000 }, envVars: {}, metadata: { purpose: "chat-runtime-disposable", attempt: ctx.input.nonce, companyId } });
  try {
    const probe = await ctx.input.api.post<EnvironmentProbeResult>(`/api/environments/${environment.id}/probe?companyId=${encodeURIComponent(companyId)}`, {}, { timeout: 330000 });
    if (typeof probe.details?.leaseId !== "string") throw new Error("Real Daytona qualification did not retain its actual lease identity");
    const [lease, saved, inventory, adapters] = await Promise.all([ctx.input.api.get<EnvironmentLease>(`/api/environment-leases/${probe.details.leaseId}`), ctx.input.api.get<Environment>(`/api/environments/${environment.id}`), ctx.input.api.get<Environment[]>(`/api/companies/${companyId}/environments`), ctx.input.api.get<Array<{ type: string; supportedRunners?: string[] }>>(`/api/adapters?companyId=${companyId}&environmentId=${environment.id}`)]);
    if (!inventory.some(row => row.id === environment.id) || saved.metadata?.attempt !== ctx.input.nonce || !ownedDaytonaProbeMatches({ companyId, environmentId: environment.id, environment: saved, probe, lease, imageRef: selection.imageRef, secretId: secret.secretId }) || !adapters.some(row => row.type === `${selection.qualifiedHarness}_local` && row.supportedRunners?.includes("paperclip"))) throw new Error("The actual newly owned Daytona image/lease/harness qualification failed independent public checks");
    return { environmentId: environment.id, companyId, secretId: secret.secretId, probeLeaseId: lease.id, qualifiedHarness: selection.qualifiedHarness as "codex" | "claude", imagePinned: true, ownership: "new-attempt-company-target", providerProbes: [{ phase: "setup", operation: "environment-probe", status: "qualified", usage: "unavailable", cost: "unavailable" }] };
  } catch (error) { await deleteDaytonaEnvironment(ctx.input.api, environment.id); throw error; }
}
export async function deleteOwnedDaytonaTarget(ctx: ChatCatalogContext, target: OwnedDaytonaTarget) {
  if (target.companyId !== ctx.input.fixtures.company.id || target.ownership !== "new-attempt-company-target") throw new Error("Refusing unowned remote target cleanup");
  const actual = await ctx.input.api.get<Environment>(`/api/environments/${target.environmentId}`);
  if (actual.metadata?.attempt !== ctx.input.nonce || actual.metadata.companyId !== target.companyId || actual.config.provider !== "daytona") throw new Error("Remote target ownership changed before cleanup");
  await deleteDaytonaEnvironment(ctx.input.api, target.environmentId);
}

import { harnessPoolBindingSchema, ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { harnessPoolsApi } from "@/api/harness-pools";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { describeError } from "@/api/errors";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { buildNewAgentRuntimeConfig } from "@/lib/new-agent-runtime-config";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { useToastActions } from "@/context/ToastContext";

/** Completes the same held name-only draft as the concrete harness setup. */
export function PoolAgentSetup({ companyId, agentId }: { companyId: string; agentId: string }) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { pushToast } = useToastActions();
  const agent = useQuery({ queryKey: queryKeys.agents.detail(agentId), queryFn: () => agentsApi.get(agentId, companyId) });
  const pools = useQuery({ queryKey: ["harness-pool-choices", companyId], queryFn: () => harnessPoolsApi.choices(companyId) });
  const experimental = useQuery({ queryKey: queryKeys.instance.experimentalSettings, queryFn: () => instanceSettingsApi.getExperimental() });
  const [selected, setSelected] = useState<string>();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const poolId = selected ?? harnessPoolBindingSchema.safeParse(agent.data?.runtimeConfig.harnessPool).data?.poolId ?? "";
  const pool = pools.data?.find(item => item.id === poolId);
  const loadError = agent.error ?? pools.error ?? experimental.error;
  async function finish() {
    if (!agent.data || !pool?.enabled || experimental.data?.enableNativeRunner !== true || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const current = agent.data;
      const sourceType = ["codex_local", "claude_local", "opencode_local", "pi_local"].includes(current.adapterType) ? current.adapterType : "paperclip_runner";
      const adapterConfig = current.adapterType === "paperclip_runner" || sourceType !== "paperclip_runner" ? current.adapterConfig : { ...current.adapterConfig, provider: "codex" };
      const result = await agentsApi.testEnvironment(companyId, sourceType, {
        agentId, adapterConfig, runner: "paperclip", aiConnection: { mode: "router", connectionId: pool.id },
        environmentId: current.defaultEnvironmentId,
      });
      if (result.status === "fail" || result.checks.some(check => check.level === "error" || check.code === ADAPTER_AUTH_MISSING_CHECK_CODE))
        throw new Error(result.checks.filter(check => check.level === "error" || check.code === ADAPTER_AUTH_MISSING_CHECK_CODE).map(check => check.message).join("; ") || "The selected pool is not ready. Repair the account or environment and try again.");
      const { aiConnection: _direct, ...runtime } = current.runtimeConfig;
      const response = await agentsApi.hire(companyId, {
        setupAgentId: agentId, name: current.name, role: current.role, reportsTo: current.reportsTo,
        appearance: current.appearance, adapterType: sourceType, runner: "paperclip", adapterConfig,
        defaultEnvironmentId: current.defaultEnvironmentId,
        runtimeConfig: { ...buildNewAgentRuntimeConfig({ heartbeatEnabled: false }), ...runtime, harnessPool: { poolId: pool.id } },
        budgetMonthlyCents: current.budgetMonthlyCents,
      });
      cache.setQueryData(queryKeys.agents.detail(response.agent.id), response.agent);
      await Promise.all([cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }), cache.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) })]);
      const warnings = result.checks.filter(check => check.level === "warn").map(check => check.message);
      if (warnings.length) pushToast({ title: "Pool configuration checked", body: warnings.join(" "), tone: "warn" });
      navigate(`/agents/${response.agent.id}`);
    } catch (failure) { setError(describeError(failure).body); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function saveAndExit() {
    if (busyRef.current) return;
    if (!agent.data || !pool?.enabled) { navigate("/agents/all"); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const { aiConnection: _direct, ...runtime } = agent.data.runtimeConfig;
      const sourceType = ["codex_local", "claude_local", "opencode_local", "pi_local"].includes(agent.data.adapterType) ? agent.data.adapterType : "paperclip_runner";
      const config = agent.data.adapterType === "paperclip_runner" || sourceType !== "paperclip_runner" ? agent.data.adapterConfig : { ...agent.data.adapterConfig, provider: "codex" };
      const saved = await agentsApi.update(agentId, { adapterType: sourceType, runner: "paperclip", adapterConfig: config,
        runtimeConfig: { ...runtime, harnessPool: { poolId: pool.id } } }, companyId);
      cache.setQueryData(queryKeys.agents.detail(agentId), saved);
      await cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      navigate("/agents/all");
    } catch (failure) { setError(describeError(failure).body); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <div className="mx-auto max-w-2xl space-y-6 p-6">
    <div className="space-y-2"><h1 className="text-lg font-semibold">{agent.data?.name ?? "New agent"} · Pool</h1><p className="text-sm text-muted-foreground">Choose a shared pool of harnesses, models and accounts. This agent uses Paperclip Runner and keeps healthy tasks on their selected member.</p></div>
    {loadError ? <p role="alert" className="text-sm text-destructive">{describeError(loadError).body} <Button variant="outline" onClick={() => { void agent.refetch(); void pools.refetch(); void experimental.refetch(); }}>Retry</Button></p> : agent.isPending || pools.isPending || experimental.isPending ? <p>Loading setup…</p> : <>
      {experimental.data?.enableNativeRunner !== true && <p role="alert">Enable Paperclip Runner in instance settings before continuing.</p>}
      <label className="block space-y-2 text-sm"><span>Harness pool</span><NativeSelect aria-label="Harness pool" value={poolId} disabled={busy || experimental.data?.enableNativeRunner !== true} onChange={event => setSelected(event.target.value)}><option value="">Choose a pool</option>{pools.data?.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{item.enabled ? "" : " (disabled)"}</option>)}</NativeSelect></label>
      {!pools.data?.length && <p className="text-sm text-muted-foreground">Create a pool in Settings → Connections first.</p>}
      {poolId && !pool && <p role="alert" className="text-sm text-destructive">The saved pool is unavailable. Choose another pool.</p>}
      <p className="text-sm text-muted-foreground">Finish setup checks the pool configuration and follows the existing hiring and approval process. Run a task to verify the selected account and harness.</p>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-2"><Button variant="outline" disabled={busy} onClick={() => void saveAndExit()}>Save & exit</Button><Button disabled={busy || Boolean(loadError) || !agent.data || !pool?.enabled || experimental.data?.enableNativeRunner !== true} onClick={() => void finish()}>{busy ? "Testing and saving…" : "Finish setup"}</Button></div>
  </div>;
}

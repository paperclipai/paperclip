import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Cloud,
  DollarSign,
  Github,
  Globe,
  Headphones,
  KeyRound,
  MessageSquare,
  Play,
  Plug,
  Server,
  ShoppingCart,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CompanyIntegrator } from "@paperclipai/shared";
import { agentsStudioApi, type IntegratorRunResult } from "../api/agentsStudio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

const ICONS: Record<string, LucideIcon> = {
  Server, Users, DollarSign, ShoppingCart, CalendarClock, ClipboardList,
  Headphones, BellRing, Cloud, KeyRound, Github, MessageSquare, BookOpen, Globe,
};

export function Integrators() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("All");

  useEffect(() => {
    setBreadcrumbs([{ label: "Integrators" }]);
  }, [setBreadcrumbs]);

  const integratorsQuery = useQuery({
    queryKey: queryKeys.agentsStudio.integrators(selectedCompanyId!),
    queryFn: () => agentsStudioApi.listIntegrators(selectedCompanyId!).then((r) => r.integrators),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agentsStudio.integrators(selectedCompanyId!) });

  const connectMutation = useMutation({
    mutationFn: (vars: { key: string; config: Record<string, unknown> }) =>
      agentsStudioApi.connectIntegrator(selectedCompanyId!, vars.key, vars.config),
    onSuccess: (res) => {
      pushToast({ title: `Connected ${res.integrator.name}`, tone: "success" });
      setOpenKey(null);
      invalidate();
    },
    onError: (e: Error) => pushToast({ title: "Connect failed", body: e.message, tone: "error" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: (key: string) => agentsStudioApi.disconnectIntegrator(selectedCompanyId!, key),
    onSuccess: (res) => {
      pushToast({ title: `Disconnected ${res.integrator.name}`, tone: "success" });
      invalidate();
    },
    onError: (e: Error) => pushToast({ title: "Disconnect failed", body: e.message, tone: "error" }),
  });

  const integrators = integratorsQuery.data ?? [];
  const categories = useMemo(() => ["All", ...Array.from(new Set(integrators.map((i) => i.category)))], [integrators]);
  const visible = activeCategory === "All" ? integrators : integrators.filter((i) => i.category === activeCategory);
  const connectedCount = integrators.filter((i) => i.status === "connected").length;

  if (!selectedCompanyId) {
    return <EmptyState icon={Plug} message="Select a company to manage integrators." />;
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Integrators</h1>
          <Badge variant="outline" className="ml-1">
            {connectedCount}/{integrators.length} connected
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect your enterprise systems. Once connected, the AI Factory makes <strong>real</strong> authenticated
          API calls — workflows and agents act on live data. Use the generic HTTP connector for anything not listed.
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setActiveCategory(c)}
            className={`rounded-full px-2.5 py-1 text-xs ${activeCategory === c ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
          >
            {c}
          </button>
        ))}
      </div>

      {integratorsQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((it) => (
            <IntegratorCard
              key={it.key}
              companyId={selectedCompanyId}
              integrator={it}
              open={openKey === it.key}
              onToggle={() => setOpenKey((cur) => (cur === it.key ? null : it.key))}
              onConnect={(config) => connectMutation.mutate({ key: it.key, config })}
              onDisconnect={() => disconnectMutation.mutate(it.key)}
              busy={connectMutation.isPending || disconnectMutation.isPending}
              pushToast={pushToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IntegratorCard({
  companyId,
  integrator,
  open,
  onToggle,
  onConnect,
  onDisconnect,
  busy,
  pushToast,
}: {
  companyId: string;
  integrator: CompanyIntegrator;
  open: boolean;
  onToggle: () => void;
  onConnect: (config: Record<string, unknown>) => void;
  onDisconnect: () => void;
  busy: boolean;
  pushToast: (t: { title: string; body?: string; tone?: "success" | "error" | "info" | "warn" }) => void;
}) {
  const Icon = ICONS[integrator.icon] ?? Plug;
  const connected = integrator.status === "connected";
  const [form, setForm] = useState<Record<string, string>>({});
  const [actionKey, setActionKey] = useState<string>(integrator.actions[0]?.key ?? "");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<IntegratorRunResult | null>(null);

  const action = integrator.actions.find((a) => a.key === actionKey);

  const runMutation = useMutation({
    mutationFn: () => agentsStudioApi.runIntegratorAction(companyId, integrator.key, actionKey, inputs),
    onSuccess: (res) => {
      setResult(res.result);
      pushToast({
        title: res.result.ok ? `${integrator.name}: ${res.result.status} OK` : `${integrator.name}: ${res.result.status || "error"}`,
        tone: res.result.ok ? "success" : "error",
      });
    },
    onError: (e: Error) => pushToast({ title: "Run failed", body: e.message, tone: "error" }),
  });

  return (
    <div className="flex flex-col rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-start gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{integrator.name}</span>
            {connected ? (
              <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Connected</Badge>
            ) : (
              <Badge variant="secondary">Available</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{integrator.category} · {integrator.actions.length} actions</p>
        </div>
      </div>
      <p className="mb-3 flex-1 text-xs text-muted-foreground">{integrator.description}</p>

      {!connected && !open && (
        <Button size="sm" variant="outline" className="w-full" onClick={onToggle}>
          <Plug className="mr-1.5 h-3.5 w-3.5" /> Connect
        </Button>
      )}

      {!connected && open && (
        <div className="space-y-2">
          {integrator.authFields.map((field) => (
            <div key={field.key} className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">{field.label}</label>
              <Input
                type={field.secret ? "password" : "text"}
                placeholder={field.placeholder}
                value={form[field.key] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="flex gap-1.5 pt-1">
            <Button size="sm" className="flex-1" disabled={busy} onClick={() => onConnect(form)}>Connect</Button>
            <Button size="sm" variant="ghost" onClick={onToggle}>Cancel</Button>
          </div>
        </div>
      )}

      {connected && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <select
              className="h-9 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
              value={actionKey}
              onChange={(e) => { setActionKey(e.target.value); setInputs({}); setResult(null); }}
            >
              {integrator.actions.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={onDisconnect}>Disconnect</Button>
          </div>
          {(action?.fields ?? []).map((f) => (
            <Input
              key={f.key}
              placeholder={`${f.label}${f.required ? " *" : ""}${f.placeholder ? ` — ${f.placeholder}` : ""}`}
              value={inputs[f.key] ?? ""}
              onChange={(e) => setInputs((s) => ({ ...s, [f.key]: e.target.value }))}
            />
          ))}
          <Button size="sm" className="w-full" disabled={runMutation.isPending} onClick={() => runMutation.mutate()}>
            <Play className="mr-1.5 h-3.5 w-3.5" /> {runMutation.isPending ? "Calling…" : "Run live action"}
          </Button>
          {result && (
            <div className="rounded-md bg-muted/50 p-2">
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <Badge variant={result.ok ? "default" : "destructive"}>{result.status || "ERR"}</Badge>
                <span className="text-muted-foreground">{result.method} · {result.durationMs}ms</span>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                {result.error ? result.error : JSON.stringify(result.data, null, 2).slice(0, 1200)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

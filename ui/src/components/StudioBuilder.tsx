import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Trash2, UserPlus, Workflow as WorkflowIcon, X } from "lucide-react";
import type { AgentDomain, ConnectorDefinition, WorkflowConnector } from "@paperclipai/shared";
import { agentsStudioApi } from "../api/agentsStudio";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DOMAINS: AgentDomain[] = ["it", "hr", "finance", "procurement", "general"];
// Model runtimes an agent can use. OpenCode is multi-provider (Qwen, GLM, etc.).
const ADAPTERS = ["claude_local", "codex_local", "gemini_local", "opencode_local", "pi_local", "cursor"] as const;

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring";

type DraftStep = { id: string; connector: WorkflowConnector; action: string; assigneeAgentId: string };

export function StudioBuilder({ companyId }: { companyId: string }) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [showAgent, setShowAgent] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);

  const connectorsQuery = useQuery({
    queryKey: queryKeys.agentsStudio.connectors(),
    queryFn: () => agentsStudioApi.listConnectors().then((r) => r.connectors),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agentsStudio.agents(companyId),
    queryFn: () => agentsStudioApi.listAgents(companyId).then((r) => r.agents),
  });

  const connectors = connectorsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];

  // --- Create Agent state ---
  const [agentName, setAgentName] = useState("");
  const [agentDomain, setAgentDomain] = useState<AgentDomain>("it");
  const [agentAdapter, setAgentAdapter] = useState<(typeof ADAPTERS)[number]>("claude_local");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [allowed, setAllowed] = useState<WorkflowConnector[]>([]);

  const createAgentMutation = useMutation({
    mutationFn: () =>
      agentsStudioApi.createAgent(companyId, {
        name: agentName.trim(),
        domain: agentDomain,
        adapterType: agentAdapter,
        instructions: agentInstructions.trim(),
        allowedIntegrators: allowed,
      }),
    onSuccess: (res) => {
      pushToast({ title: `Agent “${res.agent.name}” created`, tone: "success" });
      setAgentName("");
      setAgentInstructions("");
      setAllowed([]);
      setShowAgent(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentsStudio.agents(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
    onError: (e: Error) => pushToast({ title: "Create agent failed", body: e.message, tone: "error" }),
  });

  // --- Build Workflow state ---
  const [wfName, setWfName] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([]);

  const integrators = useMemo(() => connectors, [connectors]);

  const addStep = () => {
    const first = integrators[0];
    setSteps((s) => [
      ...s,
      {
        id: `d${Date.now()}${s.length}`,
        connector: (first?.key ?? "core") as WorkflowConnector,
        action: first?.actions[0]?.key ?? "",
        assigneeAgentId: "",
      },
    ]);
  };

  const createWorkflowMutation = useMutation({
    mutationFn: () =>
      agentsStudioApi.create(companyId, {
        name: wfName.trim(),
        status: "active",
        steps: steps.map((s, i) => ({
          id: `s${i + 1}`,
          name: actionLabel(connectors, s.connector, s.action),
          connector: s.connector,
          action: s.action,
          assigneeAgentId: s.assigneeAgentId || null,
          config: {},
        })),
        tags: [],
      }),
    onSuccess: (res) => {
      pushToast({ title: `Workflow “${res.workflow.name}” created`, tone: "success" });
      setWfName("");
      setSteps([]);
      setShowWorkflow(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentsStudio.list(companyId) });
    },
    onError: (e: Error) => pushToast({ title: "Create workflow failed", body: e.message, tone: "error" }),
  });

  const canSaveWorkflow = wfName.trim().length > 0 && steps.length > 0 && steps.every((s) => s.action);

  return (
    <section className="grid gap-3 sm:grid-cols-2">
      {/* Create Agent */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Create an agent</h3>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowAgent((v) => !v)}>
            {showAgent ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {!showAgent ? (
          <p className="text-xs text-muted-foreground">
            Spin up a specialized agent (HR, Finance, IT…) and grant it the integrators it may use.
          </p>
        ) : (
          <div className="space-y-2">
            <Input placeholder="Agent name, e.g. HR Onboarding Agent" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            <select className={selectCls} value={agentDomain} onChange={(e) => setAgentDomain(e.target.value as AgentDomain)}>
              {DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d.toUpperCase()}
                </option>
              ))}
            </select>
            <select className={selectCls} value={agentAdapter} onChange={(e) => setAgentAdapter(e.target.value as (typeof ADAPTERS)[number])}>
              {ADAPTERS.map((a) => (
                <option key={a} value={a}>
                  {getAdapterLabel(a)}
                </option>
              ))}
            </select>
            <textarea
              className={`${selectCls} h-16 py-1.5`}
              placeholder="Instructions / persona"
              value={agentInstructions}
              onChange={(e) => setAgentInstructions(e.target.value)}
            />
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">Allowed integrators</p>
              <div className="flex flex-wrap gap-1">
                {integrators
                  .filter((c) => c.isIntegrator)
                  .map((c) => {
                    const on = allowed.includes(c.key);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setAllowed((a) => (on ? a.filter((k) => k !== c.key) : [...a, c.key]))}
                        className={`rounded-md px-1.5 py-0.5 text-[11px] ${on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
              </div>
            </div>
            <Button size="sm" className="w-full" disabled={!agentName.trim() || createAgentMutation.isPending} onClick={() => createAgentMutation.mutate()}>
              <Bot className="mr-1.5 h-3.5 w-3.5" />
              Create agent
            </Button>
          </div>
        )}
      </div>

      {/* Build Workflow */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Build a workflow</h3>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowWorkflow((v) => !v)}>
            {showWorkflow ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {!showWorkflow ? (
          <p className="text-xs text-muted-foreground">
            Stitch integrator actions into a sequence and assign each step to an agent.
          </p>
        ) : (
          <div className="space-y-2">
            <Input placeholder="Workflow name" value={wfName} onChange={(e) => setWfName(e.target.value)} />
            <div className="space-y-2">
              {steps.map((step, idx) => {
                const conn = connectors.find((c) => c.key === step.connector);
                return (
                  <div key={step.id} className="rounded-md border bg-muted/30 p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted-foreground">Step {idx + 1}</span>
                      <button type="button" onClick={() => setSteps((s) => s.filter((x) => x.id !== step.id))}>
                        <Trash2 className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-1.5">
                      <select
                        className={selectCls}
                        value={step.connector}
                        onChange={(e) => {
                          const key = e.target.value as WorkflowConnector;
                          const c = connectors.find((x) => x.key === key);
                          setSteps((s) => s.map((x) => (x.id === step.id ? { ...x, connector: key, action: c?.actions[0]?.key ?? "" } : x)));
                        }}
                      >
                        {connectors.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className={selectCls}
                        value={step.action}
                        onChange={(e) => setSteps((s) => s.map((x) => (x.id === step.id ? { ...x, action: e.target.value } : x)))}
                      >
                        {(conn?.actions ?? []).map((a) => (
                          <option key={a.key} value={a.key}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className={selectCls}
                        value={step.assigneeAgentId}
                        onChange={(e) => setSteps((s) => s.map((x) => (x.id === step.id ? { ...x, assigneeAgentId: e.target.value } : x)))}
                      >
                        <option value="">Unassigned</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
            <Button size="sm" variant="outline" className="w-full" onClick={addStep}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add step
            </Button>
            <Button size="sm" className="w-full" disabled={!canSaveWorkflow || createWorkflowMutation.isPending} onClick={() => createWorkflowMutation.mutate()}>
              Save workflow
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function actionLabel(connectors: ConnectorDefinition[], connector: string, action: string): string {
  const a = connectors.find((c) => c.key === connector)?.actions.find((x) => x.key === action);
  return a?.label ?? action;
}

import { useState } from "react";
import { Plus, Zap, Trash2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tauriInvoke } from "@/api/tauri-client";
import { useCompany } from "@/context/CompanyContext";

interface AutomationRule {
  id: string;
  company_id: string;
  name: string;
  trigger_type: string;
  trigger_config: string;
  action_type: string;
  action_config: string;
  enabled: boolean;
  created_at: string;
}

export function Automation() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formTriggerType, setFormTriggerType] = useState("file_change");
  const [formPath, setFormPath] = useState("");
  const [formActionType, setFormActionType] = useState("wake_agent");
  const [formActionConfig, setFormActionConfig] = useState("");

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["automation-rules", selectedCompanyId],
    queryFn: () => tauriInvoke<AutomationRule[]>("list_automation_rules", { companyId: selectedCompanyId! }),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; triggerType: string; triggerConfig: string; actionType: string; actionConfig: string }) =>
      tauriInvoke<AutomationRule>("create_automation_rule", {
        companyId: selectedCompanyId!,
        name: data.name,
        triggerType: data.triggerType,
        triggerConfig: data.triggerConfig,
        actionType: data.actionType,
        actionConfig: data.actionConfig,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automation-rules", selectedCompanyId] });
      setShowForm(false);
      setFormName("");
      setFormPath("");
      setFormActionConfig("");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) =>
      tauriInvoke("toggle_automation_rule", { id: args.id, enabled: args.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-rules", selectedCompanyId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tauriInvoke("delete_automation_rule", { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-rules", selectedCompanyId] }),
  });

  const handleCreate = () => {
    if (!formName.trim()) return;
    createMutation.mutate({
      name: formName,
      triggerType: formTriggerType,
      triggerConfig: JSON.stringify({ path: formPath }),
      actionType: formActionType,
      actionConfig: formActionConfig || "{}",
    });
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Automation</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--fg-muted)" }}>
            Connect triggers to actions — no code required
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          <Plus size={15} /> New Rule
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border p-5" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          <h3 className="mb-4 text-[13px] font-semibold" style={{ color: "var(--fg)" }}>Create Automation Rule</h3>
          <div className="grid gap-3">
            <div>
              <label className="mb-1 block text-[12px]" style={{ color: "var(--fg-muted)" }}>Name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g., Auto-wake on file change"
                className="w-full rounded-md border px-3 py-2 text-[13px] outline-none"
                style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)" }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[12px]" style={{ color: "var(--fg-muted)" }}>Trigger Type</label>
                <select
                  value={formTriggerType}
                  onChange={(e) => setFormTriggerType(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-[13px] outline-none"
                  style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)" }}
                >
                  <option value="file_change">File Change</option>
                  <option value="schedule">Schedule</option>
                  <option value="webhook">Webhook</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[12px]" style={{ color: "var(--fg-muted)" }}>Action Type</label>
                <select
                  value={formActionType}
                  onChange={(e) => setFormActionType(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-[13px] outline-none"
                  style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)" }}
                >
                  <option value="wake_agent">Wake Agent</option>
                  <option value="run_script">Run Script</option>
                  <option value="notify">Notify</option>
                </select>
              </div>
            </div>
            {formTriggerType === "file_change" && (
              <div>
                <label className="mb-1 block text-[12px]" style={{ color: "var(--fg-muted)" }}>Watch Path</label>
                <input
                  value={formPath}
                  onChange={(e) => setFormPath(e.target.value)}
                  placeholder="e.g., /path/to/project/src"
                  className="w-full rounded-md border px-3 py-2 text-[13px] outline-none"
                  style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-mono)" }}
                />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowForm(false)}
                className="rounded-md border px-3 py-1.5 text-[13px]"
                style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!formName.trim() || createMutation.isPending}
                className="rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                {createMutation.isPending ? "Creating..." : "Create Rule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>Loading...</div>
      ) : rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border py-16" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          <Zap size={32} className="mb-3 opacity-30" style={{ color: "var(--fg-muted)" }} />
          <p className="text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>No automation rules configured</p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>Click "New Rule" to create your first automation.</p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)", divideColor: "var(--border-subtle)" }}>
          {rules.map((rule) => {
            let triggerLabel = rule.trigger_type.replace("_", " ");
            try {
              const tc = JSON.parse(rule.trigger_config);
              if (tc.path) triggerLabel += `: ${tc.path}`;
            } catch { /* empty */ }

            return (
              <div key={rule.id} className="flex items-center gap-4 px-5 py-3 text-[13px]">
                <button
                  onClick={() => toggleMutation.mutate({ id: rule.id, enabled: !rule.enabled })}
                  className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                  style={{ background: rule.enabled ? "var(--accent)" : "var(--bg-muted)" }}
                >
                  <span
                    className="absolute top-0.5 h-4 w-4 rounded-full transition-transform"
                    style={{
                      background: "white",
                      left: rule.enabled ? "18px" : "2px",
                    }}
                  />
                </button>
                <div className="flex-1">
                  <div className="font-medium" style={{ color: rule.enabled ? "var(--fg)" : "var(--fg-muted)" }}>{rule.name}</div>
                  <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                    {triggerLabel} → {rule.action_type.replace("_", " ")}
                  </div>
                </div>
                <button
                  onClick={() => deleteMutation.mutate(rule.id)}
                  className="rounded p-1 transition-colors hover:bg-[var(--bg-muted)]"
                  style={{ color: "var(--fg-muted)" }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

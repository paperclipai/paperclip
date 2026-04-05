import { useEffect, useState, useCallback } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  Zap,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Pencil,
  X,
  ChevronDown,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Trigger =
  | "issue_created"
  | "status_changed"
  | "agent_failed"
  | "budget_threshold_reached";

type Action =
  | "assign_agent"
  | "change_status"
  | "send_notification"
  | "create_issue";

interface AutomationRule {
  id: string;
  name: string;
  trigger: Trigger;
  triggerValue: string;
  action: Action;
  actionValue: string;
  enabled: boolean;
  createdAt: string;
}

const TRIGGER_OPTIONS: { value: Trigger; label: string; hint: string }[] = [
  {
    value: "issue_created",
    label: "Issue created",
    hint: "Fires when any new issue is created",
  },
  {
    value: "status_changed",
    label: "Status changed",
    hint: "Fires when an issue status changes to a specified value",
  },
  {
    value: "agent_failed",
    label: "Agent failed",
    hint: "Fires when an agent run ends in an error state",
  },
  {
    value: "budget_threshold_reached",
    label: "Budget threshold reached",
    hint: "Fires when spending exceeds a dollar amount",
  },
];

const ACTION_OPTIONS: { value: Action; label: string; hint: string }[] = [
  {
    value: "assign_agent",
    label: "Assign agent",
    hint: "Auto-assign an agent to the triggering issue",
  },
  {
    value: "change_status",
    label: "Change status",
    hint: "Update the issue status automatically",
  },
  {
    value: "send_notification",
    label: "Send notification",
    hint: "Send an inbox notification to all team members",
  },
  {
    value: "create_issue",
    label: "Create issue",
    hint: "Create a follow-up issue automatically",
  },
];

const TRIGGER_VALUE_LABELS: Record<Trigger, string> = {
  issue_created: "Project filter (optional)",
  status_changed: "Target status (e.g. in_progress, done)",
  agent_failed: "Agent name filter (optional)",
  budget_threshold_reached: "Threshold in dollars (e.g. 50)",
};

const ACTION_VALUE_LABELS: Record<Action, string> = {
  assign_agent: "Agent name to assign",
  change_status: "New status value",
  send_notification: "Notification message",
  create_issue: "Issue title",
};

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ironworks:automation-rules";

function loadRules(): AutomationRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRules(rules: AutomationRule[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}

function generateId(): string {
  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AutomationRules() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [rules, setRules] = useState<AutomationRule[]>(loadRules);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formTrigger, setFormTrigger] = useState<Trigger>("issue_created");
  const [formTriggerValue, setFormTriggerValue] = useState("");
  const [formAction, setFormAction] = useState<Action>("assign_agent");
  const [formActionValue, setFormActionValue] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Automation Rules" }]);
  }, [setBreadcrumbs]);

  const persist = useCallback(
    (next: AutomationRule[]) => {
      setRules(next);
      saveRules(next);
    },
    [],
  );

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setFormName("");
    setFormTrigger("issue_created");
    setFormTriggerValue("");
    setFormAction("assign_agent");
    setFormActionValue("");
  }

  function handleSave() {
    if (!formName.trim()) return;
    if (editingId) {
      persist(
        rules.map((r) =>
          r.id === editingId
            ? {
                ...r,
                name: formName.trim(),
                trigger: formTrigger,
                triggerValue: formTriggerValue.trim(),
                action: formAction,
                actionValue: formActionValue.trim(),
              }
            : r,
        ),
      );
      pushToast({ title: "Rule updated", tone: "success" });
    } else {
      const newRule: AutomationRule = {
        id: generateId(),
        name: formName.trim(),
        trigger: formTrigger,
        triggerValue: formTriggerValue.trim(),
        action: formAction,
        actionValue: formActionValue.trim(),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      persist([...rules, newRule]);
      pushToast({ title: "Rule created", tone: "success" });
    }
    resetForm();
  }

  function handleToggle(id: string) {
    persist(
      rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
  }

  function handleDelete(id: string) {
    persist(rules.filter((r) => r.id !== id));
    pushToast({ title: "Rule deleted", tone: "success" });
  }

  function startEdit(rule: AutomationRule) {
    setEditingId(rule.id);
    setFormName(rule.name);
    setFormTrigger(rule.trigger);
    setFormTriggerValue(rule.triggerValue);
    setFormAction(rule.action);
    setFormActionValue(rule.actionValue);
    setShowForm(true);
  }

  const triggerLabel = (t: Trigger) =>
    TRIGGER_OPTIONS.find((o) => o.value === t)?.label ?? t;
  const actionLabel = (a: Action) =>
    ACTION_OPTIONS.find((o) => o.value === a)?.label ?? a;

  return (
    <div className="p-6 max-w-4xl space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Automation Rules
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Define when/then rules to automate common workflows.
            </p>
          </div>
        </div>
        {!showForm && (
          <Button
            size="sm"
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            New Rule
          </Button>
        )}
      </div>

      {/* Rule builder form */}
      {showForm && (
        <div className="rounded-lg border border-border p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {editingId ? "Edit Rule" : "Create Rule"}
            </h2>
            <button
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={resetForm}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Rule name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Rule name</label>
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-primary"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Auto-assign triage agent on new issues"
            />
          </div>

          {/* When / Then visual */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* WHEN */}
            <div className="space-y-3 rounded-md border border-border p-4 bg-muted/20">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  When
                </span>
                <span className="text-xs text-muted-foreground">
                  (trigger)
                </span>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Event</label>
                <div className="relative">
                  <select
                    value={formTrigger}
                    onChange={(e) =>
                      setFormTrigger(e.target.value as Trigger)
                    }
                    className="w-full appearance-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none pr-8"
                  >
                    {TRIGGER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {TRIGGER_OPTIONS.find((o) => o.value === formTrigger)?.hint}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  {TRIGGER_VALUE_LABELS[formTrigger]}
                </label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={formTriggerValue}
                  onChange={(e) => setFormTriggerValue(e.target.value)}
                  placeholder="Optional filter value"
                />
              </div>
            </div>

            {/* THEN */}
            <div className="space-y-3 rounded-md border border-border p-4 bg-muted/20">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                  Then
                </span>
                <span className="text-xs text-muted-foreground">
                  (action)
                </span>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Action</label>
                <div className="relative">
                  <select
                    value={formAction}
                    onChange={(e) =>
                      setFormAction(e.target.value as Action)
                    }
                    className="w-full appearance-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none pr-8"
                  >
                    {ACTION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {ACTION_OPTIONS.find((o) => o.value === formAction)?.hint}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  {ACTION_VALUE_LABELS[formAction]}
                </label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={formActionValue}
                  onChange={(e) => setFormActionValue(e.target.value)}
                  placeholder="Value for this action"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!formName.trim()}
            >
              {editingId ? "Update Rule" : "Create Rule"}
            </Button>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Rule list */}
      {rules.length === 0 && !showForm && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <Zap className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No automation rules yet. Create one to automate repetitive tasks.
          </p>
        </div>
      )}

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className={`rounded-lg border px-4 py-3 flex items-center gap-4 transition-colors ${
                rule.enabled
                  ? "border-border"
                  : "border-border/50 opacity-60"
              }`}
            >
              {/* Toggle */}
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => handleToggle(rule.id)}
                title={rule.enabled ? "Disable rule" : "Enable rule"}
              >
                {rule.enabled ? (
                  <ToggleRight className="h-5 w-5 text-primary" />
                ) : (
                  <ToggleLeft className="h-5 w-5" />
                )}
              </button>

              {/* Details */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {rule.name}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium">
                    When: {triggerLabel(rule.trigger)}
                  </span>
                  {rule.triggerValue && (
                    <span className="font-mono text-[11px]">
                      ({rule.triggerValue})
                    </span>
                  )}
                  <span className="text-border">-&gt;</span>
                  <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 bg-blue-500/10 text-blue-700 dark:text-blue-400 font-medium">
                    Then: {actionLabel(rule.action)}
                  </span>
                  {rule.actionValue && (
                    <span className="font-mono text-[11px]">
                      ({rule.actionValue})
                    </span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => startEdit(rule)}
                  title="Edit rule"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive"
                  onClick={() => handleDelete(rule.id)}
                  title="Delete rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

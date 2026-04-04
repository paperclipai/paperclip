import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { autoLabelRulesApi, type DryRunResult } from "../api/autoLabelRules";
import { queryKeys } from "../lib/queryKeys";
import { Field, HintIcon, ToggleField, AutoExpandTextarea } from "../components/agent-config-primitives";
import { EmptyState } from "../components/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Settings, CircleDot, Plus, Pencil, Trash2, Play, History, AlertTriangle } from "lucide-react";
import type {
  Goal,
  AutoLabelRule,
  AutoLabelRuleExecution,
  IssueLabel,
  CreateAutoLabelRule,
  UpdateAutoLabelRule,
  Issue,
} from "@paperclipai/shared";
import { AUTO_LABEL_TRIGGER_EVENTS, AUTO_LABEL_RULE_ACTIONS } from "@paperclipai/shared";

/* ── Helpers ────────────────────────────────────────────────────────── */

function ReadOnlyValue({ value, mono }: { value: string; mono?: boolean }) {
  return (
    <div
      className={`rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm ${mono ? "font-mono" : ""} text-muted-foreground`}
    >
      {value}
    </div>
  );
}

function findDefaultCompanyGoal(goals: Goal[]): Goal | null {
  const companyGoals = goals.filter((g) => g.level === "company" && !g.parentId);
  const active = companyGoals.find((g) => g.status === "active");
  if (active) return active;
  return companyGoals[0] ?? null;
}

function LabelBadge({ label }: { label: IssueLabel }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ backgroundColor: `${label.color}20`, color: label.color }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: label.color }}
      />
      {label.name}
    </span>
  );
}

function formatTriggerEvent(event: string): string {
  return event.replace(/_/g, " ").replace(/\./g, " > ");
}

function formatAction(action: string): string {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function formatTimestamp(ts: string | Date): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Types for form state ───────────────────────────────────────────── */

interface RuleFormData {
  name: string;
  description: string;
  triggerEvent: string;
  conditionExpression: string;
  action: string;
  labelId: string;
  enabled: boolean;
  priority: number;
}

const EMPTY_FORM: RuleFormData = {
  name: "",
  description: "",
  triggerEvent: "issue.created",
  conditionExpression: "",
  action: "apply",
  labelId: "",
  enabled: true,
  priority: 0,
};

/* ── Create/Edit Rule Dialog ────────────────────────────────────────── */

function RuleFormDialog({
  open,
  onOpenChange,
  companyId,
  labels,
  editingRule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  labels: IssueLabel[];
  editingRule: AutoLabelRule | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const isEdit = editingRule !== null;

  const [form, setForm] = useState<RuleFormData>(EMPTY_FORM);

  useEffect(() => {
    if (open) {
      if (editingRule) {
        setForm({
          name: editingRule.name,
          description: editingRule.description ?? "",
          triggerEvent: editingRule.triggerEvent,
          conditionExpression: editingRule.conditionExpression,
          action: editingRule.action,
          labelId: editingRule.labelId,
          enabled: editingRule.enabled,
          priority: editingRule.priority,
        });
      } else {
        setForm(EMPTY_FORM);
      }
    }
  }, [open, editingRule]);

  const createMutation = useMutation({
    mutationFn: (data: CreateAutoLabelRule) => autoLabelRulesApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.autoLabelRules.list(companyId) });
      pushToast({ title: "Rule created", tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to create rule",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateAutoLabelRule) => autoLabelRulesApi.update(editingRule!.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.autoLabelRules.list(companyId) });
      pushToast({ title: "Rule updated", tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update rule",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  function handleSubmit() {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      triggerEvent: form.triggerEvent as CreateAutoLabelRule["triggerEvent"],
      conditionExpression: form.conditionExpression.trim(),
      action: form.action as CreateAutoLabelRule["action"],
      labelId: form.labelId,
      enabled: form.enabled,
      priority: form.priority,
    };

    if (!payload.name || !payload.conditionExpression || !payload.labelId) {
      pushToast({ title: "Please fill in all required fields", tone: "warn" });
      return;
    }

    if (isEdit) {
      updateMutation.mutate(payload);
    } else {
      createMutation.mutate(payload);
    }
  }

  const canSubmit = form.name.trim() && form.conditionExpression.trim() && form.labelId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Auto-Label Rule" : "Create Auto-Label Rule"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the rule configuration."
              : "Define a rule that automatically applies or removes labels based on conditions."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          <Field label="Name" hint="A short, descriptive name for this rule (max 120 chars).">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Apply 'urgent' on critical issues"
              maxLength={120}
            />
          </Field>

          <Field label="Description" hint="Optional description (max 500 chars).">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Optional description..."
              maxLength={500}
            />
          </Field>

          <Field label="Trigger event" hint="When should this rule be evaluated?">
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={form.triggerEvent}
              onChange={(e) => setForm((f) => ({ ...f, triggerEvent: e.target.value }))}
            >
              {AUTO_LABEL_TRIGGER_EVENTS.map((evt) => (
                <option key={evt} value={evt}>
                  {formatTriggerEvent(evt)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Condition expression (CEL)" hint="A CEL expression that must evaluate to true for the action to fire. Available context: issue, actor, event, comment, workProduct.">
            <AutoExpandTextarea
              value={form.conditionExpression}
              onChange={(v) => setForm((f) => ({ ...f, conditionExpression: v }))}
              placeholder='e.g. issue.priority == "critical"'
              minRows={3}
            />
            <div className="mt-1 text-[10px] text-muted-foreground/60">
              CEL syntax: use <code className="bg-muted px-1 rounded">==</code>, <code className="bg-muted px-1 rounded">!=</code>, <code className="bg-muted px-1 rounded">&&</code>, <code className="bg-muted px-1 rounded">||</code>, <code className="bg-muted px-1 rounded">has()</code>
            </div>
          </Field>

          <Field label="Action" hint="What to do with the target label when the condition matches.">
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={form.action}
              onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
            >
              {AUTO_LABEL_RULE_ACTIONS.map((act) => (
                <option key={act} value={act}>
                  {formatAction(act)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Target label" hint="The label to apply, remove, or toggle when the condition is met.">
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={form.labelId}
              onChange={(e) => setForm((f) => ({ ...f, labelId: e.target.value }))}
            >
              <option value="">Select a label...</option>
              {labels.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Priority" hint="Evaluation order (0 = first). Rules are evaluated in ascending priority order (0-10000).">
            <input
              type="number"
              className="w-24 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring font-mono"
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: Math.max(0, Math.min(10000, Number(e.target.value) || 0)) }))}
              min={0}
              max={10000}
            />
          </Field>

          <ToggleField
            label="Enabled"
            hint="Disabled rules are skipped during evaluation."
            checked={form.enabled}
            onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending || !canSubmit}>
            {isPending ? (isEdit ? "Saving..." : "Creating...") : isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Delete Confirmation Dialog ─────────────────────────────────────── */

function DeleteRuleDialog({
  open,
  onOpenChange,
  rule,
  companyId,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: AutoLabelRule | null;
  companyId: string;
  labels: IssueLabel[];
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const deleteMutation = useMutation({
    mutationFn: () => autoLabelRulesApi.remove(rule!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.autoLabelRules.list(companyId) });
      pushToast({ title: "Rule deleted", tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to delete rule",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!rule) return null;

  const targetLabel = labels.find((l) => l.id === rule.labelId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Delete Rule
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone. The rule and its execution history will be permanently removed.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/30 px-3 py-3 space-y-1 text-sm">
          <div className="font-medium">{rule.name}</div>
          <div className="text-xs text-muted-foreground">
            {formatAction(rule.action)} {targetLabel ? <LabelBadge label={targetLabel} /> : rule.labelId.slice(0, 8)} on {formatTriggerEvent(rule.triggerEvent)}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleteMutation.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Dry-Run Test Dialog ────────────────────────────────────────────── */

function DryRunDialog({
  open,
  onOpenChange,
  rule,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: AutoLabelRule | null;
  companyId: string;
}) {
  const { pushToast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [result, setResult] = useState<DryRunResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounce search input by 300ms
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery]);

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.search(companyId, debouncedQuery),
    queryFn: () => issuesApi.list(companyId, { q: debouncedQuery }),
    enabled: open && !!companyId && debouncedQuery.length >= 2,
  });

  const dryRunMutation = useMutation({
    mutationFn: () => autoLabelRulesApi.dryRun(rule!.id, selectedIssueId),
    onSuccess: (data) => setResult(data),
    onError: (err) => {
      pushToast({
        title: "Dry-run failed",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setDebouncedQuery("");
      setSelectedIssueId("");
      setResult(null);
    }
  }, [open]);

  if (!rule) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Test Rule: {rule.name}</DialogTitle>
          <DialogDescription>
            Dry-run this rule against an existing issue to see what would happen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Search for an issue" hint="Type at least 2 characters to search.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Type to search issues..."
            />
          </Field>

          {issues && issues.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
              {issues.slice(0, 20).map((issue: Issue) => (
                <button
                  key={issue.id}
                  type="button"
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-accent/50 border-b border-border last:border-0 ${
                    selectedIssueId === issue.id ? "bg-accent/30" : ""
                  }`}
                  onClick={() => setSelectedIssueId(issue.id)}
                >
                  <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>{" "}
                  <span className="truncate">{issue.title}</span>
                </button>
              ))}
            </div>
          )}

          {selectedIssueId && (
            <Button
              className="w-full"
              onClick={() => dryRunMutation.mutate()}
              disabled={dryRunMutation.isPending}
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              {dryRunMutation.isPending ? "Running..." : "Run Test"}
            </Button>
          )}

          {result && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Condition result</span>
                <span className={`text-xs font-medium ${result.conditionResult ? "text-green-600" : "text-muted-foreground"}`}>
                  {result.conditionResult ? "Matched" : "Not matched"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Would apply action</span>
                <span className="text-xs font-medium">
                  {result.wouldApplyAction ? formatAction(result.wouldApplyAction) : "None (condition false)"}
                </span>
              </div>
              {result.evaluationError && (
                <div className="text-xs text-destructive mt-1">
                  Error: {result.evaluationError}
                </div>
              )}
              <div className="border-t border-border pt-2 text-xs text-muted-foreground">
                Tested against: <span className="font-mono">{result.issue.identifier}</span> {result.issue.title}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Audit Log Dialog ───────��───────────────────────────────────────── */

function AuditLogDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: AutoLabelRule | null;
}) {
  const { data: executions, isLoading } = useQuery({
    queryKey: queryKeys.autoLabelRules.executions(rule?.id ?? ""),
    queryFn: () => autoLabelRulesApi.listExecutions(rule!.id),
    enabled: open && !!rule,
  });

  // Resolve issue identifiers from execution issueIds
  const uniqueIssueIds = useMemo(() => {
    if (!executions) return [];
    return [...new Set(executions.map((e: AutoLabelRuleExecution) => e.issueId))];
  }, [executions]);

  const issueQueries = useQueries({
    queries: uniqueIssueIds.map((id) => ({
      queryKey: queryKeys.issues.detail(id),
      queryFn: () => issuesApi.get(id),
      staleTime: 5 * 60 * 1000, // cache for 5 min
    })),
  });

  const issueMap = useMemo(() => {
    const map = new Map<string, { identifier: string; title: string }>();
    issueQueries.forEach((q, i) => {
      if (q.data) {
        map.set(uniqueIssueIds[i], { identifier: q.data.identifier ?? uniqueIssueIds[i].slice(0, 8), title: q.data.title });
      }
    });
    return map;
  }, [issueQueries, uniqueIssueIds]);

  if (!rule) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Execution History: {rule.name}</DialogTitle>
          <DialogDescription>
            Recent executions of this auto-label rule (most recent first).
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto">
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">Loading...</div>
          ) : !executions || executions.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              No executions recorded yet.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {executions.map((exec: AutoLabelRuleExecution) => (
                <div key={exec.id} className="py-2.5 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatTimestamp(exec.createdAt)}
                    </span>
                    <span
                      className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${
                        exec.conditionResult
                          ? "bg-green-600/15 text-green-600"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {exec.conditionResult ? "Matched" : "Not matched"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Issue:</span>
                    {issueMap.has(exec.issueId) ? (
                      <span>
                        <span className="font-mono">{issueMap.get(exec.issueId)!.identifier}</span>
                        {" "}
                        <span className="text-muted-foreground truncate">{issueMap.get(exec.issueId)!.title}</span>
                      </span>
                    ) : (
                      <span className="font-mono">{exec.issueId.slice(0, 8)}…</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Trigger:</span>
                    <span>{formatTriggerEvent(exec.triggerEventType)}</span>
                  </div>
                  {exec.actionTaken && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Action:</span>
                      <span className="font-medium">{exec.actionTaken}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Auto-Label Rules Section ───────────────────────────────────────── */

function AutoLabelRulesSection({
  companyId,
  labels,
}: {
  companyId: string;
  labels: IssueLabel[];
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AutoLabelRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<AutoLabelRule | null>(null);
  const [testingRule, setTestingRule] = useState<AutoLabelRule | null>(null);
  const [auditRule, setAuditRule] = useState<AutoLabelRule | null>(null);

  const { data: rules, isLoading, error } = useQuery({
    queryKey: queryKeys.autoLabelRules.list(companyId),
    queryFn: () => autoLabelRulesApi.list(companyId),
    enabled: !!companyId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      autoLabelRulesApi.update(ruleId, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.autoLabelRules.list(companyId) });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to toggle rule",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  // Feature flag may be disabled — show graceful message
  if (error) {
    const status = (error as { status?: number }).status;
    if (status === 403) {
      return (
        <div className="rounded-md border border-dashed border-border px-4 py-4 text-xs text-muted-foreground space-y-2">
          <p>
            <strong>Auto-label rules engine is not enabled.</strong> Enable the{" "}
            <code className="bg-muted px-1 rounded">autoLabelRulesEngine</code> experimental flag
            in Instance Settings to use this feature.
          </p>
        </div>
      );
    }
    return (
      <div className="text-sm text-destructive">
        Failed to load auto-label rules: {error instanceof Error ? error.message : "Unknown error"}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {isLoading
            ? "Loading rules..."
            : rules && rules.length > 0
              ? `${rules.length} rule${rules.length !== 1 ? "s" : ""} configured`
              : "No rules configured yet."}
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Rule
        </Button>
      </div>

      {rules && rules.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Name</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Trigger</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Action</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Label</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Enabled</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule: AutoLabelRule) => {
                const targetLabel = labels.find((l) => l.id === rule.labelId);
                return (
                  <tr key={rule.id} className="border-b border-border last:border-0 hover:bg-accent/20">
                    <td className="px-3 py-2">
                      <div className="font-medium text-sm">{rule.name}</div>
                      {rule.description && (
                        <div className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                          {rule.description}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 truncate max-w-[200px]">
                        {rule.conditionExpression}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {formatTriggerEvent(rule.triggerEvent)}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {formatAction(rule.action)}
                    </td>
                    <td className="px-3 py-2">
                      {targetLabel ? <LabelBadge label={targetLabel} /> : (
                        <span className="text-xs text-muted-foreground italic">unknown</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={rule.enabled}
                        aria-label={`Toggle ${rule.name}`}
                        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                          rule.enabled ? "bg-green-600" : "bg-muted"
                        }`}
                        onClick={() => toggleMutation.mutate({ ruleId: rule.id, enabled: !rule.enabled })}
                      >
                        <span
                          className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                            rule.enabled ? "translate-x-3.5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Test rule"
                          onClick={() => setTestingRule(rule)}
                        >
                          <Play className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Execution history"
                          onClick={() => setAuditRule(rule)}
                        >
                          <History className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Edit rule"
                          onClick={() => setEditingRule(rule)}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Delete rule"
                          onClick={() => setDeletingRule(rule)}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <RuleFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        companyId={companyId}
        labels={labels}
        editingRule={null}
      />

      {/* Edit dialog */}
      <RuleFormDialog
        open={editingRule !== null}
        onOpenChange={(open) => { if (!open) setEditingRule(null); }}
        companyId={companyId}
        labels={labels}
        editingRule={editingRule}
      />

      {/* Delete dialog */}
      <DeleteRuleDialog
        open={deletingRule !== null}
        onOpenChange={(open) => { if (!open) setDeletingRule(null); }}
        rule={deletingRule}
        companyId={companyId}
        labels={labels}
      />

      {/* Dry-run dialog */}
      <DryRunDialog
        open={testingRule !== null}
        onOpenChange={(open) => { if (!open) setTestingRule(null); }}
        rule={testingRule}
        companyId={companyId}
      />

      {/* Audit log dialog */}
      <AuditLogDialog
        open={auditRule !== null}
        onOpenChange={(open) => { if (!open) setAuditRule(null); }}
        rule={auditRule}
      />
    </>
  );
}

/* ── Main Page ───��──────────────────────────────────────────────────── */

export function IssueSettings() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Issues", href: "/issues" },
      { label: "Settings" },
    ]);
  }, [setBreadcrumbs]);

  if (!selectedCompany || !selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issue settings." />;
  }

  const defaultGoal = goals ? findDefaultCompanyGoal(goals) : null;
  const fromBoardLabel = labels?.find((l) => l.name === "From Board") ?? null;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Issue Settings</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Read-only view of the current issue configuration for this company.
        These settings reflect hardcoded defaults and active company state.
      </p>

      {/* Issue Identification */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Issue Identification
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Issue prefix" hint="The prefix used for all issue identifiers in this company (e.g. PAP-1, PAP-2).">
            <ReadOnlyValue value={selectedCompany.issuePrefix} mono />
          </Field>
          <Field label="Next issue number" hint="The next sequential number that will be assigned to a new issue.">
            <ReadOnlyValue value={String(selectedCompany.issueCounter + 1)} mono />
          </Field>
        </div>
      </div>

      {/* Default Behaviors */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Default Behaviors
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Default status" hint="The status assigned to new issues when no explicit status is provided.">
            <ReadOnlyValue value="backlog" />
          </Field>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground/60">Hardcoded in schema. Not yet configurable per company.</span>
          </div>

          <div className="border-t border-border pt-3" />

          <Field label="Default priority" hint="The priority assigned to new issues when no explicit priority is provided.">
            <ReadOnlyValue value="medium" />
          </Field>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground/60">Hardcoded in schema. Not yet configurable per company.</span>
          </div>
        </div>
      </div>

      {/* Goal Fallback */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Goal Fallback
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="text-xs text-muted-foreground space-y-1">
            <p>When a new issue is created without an explicit goal, the system resolves one using this cascade:</p>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li>Explicit <code className="text-[11px] bg-muted px-1 rounded">goalId</code> provided at creation time</li>
              <li>The goal linked to the issue's project (if any)</li>
              <li>The default company goal (shown below)</li>
            </ol>
          </div>

          <div className="border-t border-border pt-3" />

          <Field label="Default company goal" hint="The active root-level company goal used as fallback when no project goal applies.">
            {defaultGoal ? (
              <Link
                to={`/goals/${defaultGoal.id}`}
                className="block rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm hover:bg-accent/30 transition-colors"
              >
                <span className="font-medium">{defaultGoal.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  ({defaultGoal.status})
                </span>
              </Link>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm text-muted-foreground italic">
                No company-level goal found. Issues created without a project will not inherit a goal.
              </div>
            )}
          </Field>
        </div>
      </div>

      {/* Automatic Labeling */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Automatic Labeling
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">&quot;From Board&quot; auto-label</span>
              <HintIcon text="When a board user creates an issue, the system automatically applies a 'From Board' label to distinguish board-authored issues from agent-created ones." />
            </div>
            <span className="rounded-full bg-green-600/15 px-2 py-0.5 text-[10px] font-medium text-green-600">
              Active
            </span>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p>This behavior is hardcoded in the issue creation service. When a board user creates an issue:</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>The <strong>From Board</strong> label is looked up or created automatically</li>
              <li>It is applied to the new issue alongside any explicitly provided labels</li>
              <li>Agent-created issues are not affected</li>
            </ul>
          </div>

          <div className="border-t border-border pt-3" />

          <Field label="Label status" hint="Whether the 'From Board' label currently exists in this company.">
            {fromBoardLabel ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <span
                  className="inline-block h-3 w-3 rounded-full shrink-0"
                  style={{ backgroundColor: fromBoardLabel.color }}
                />
                <span>{fromBoardLabel.name}</span>
                <span className="text-xs text-muted-foreground ml-auto">exists</span>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm text-muted-foreground italic">
                Not yet created. Will be auto-created on the first board-authored issue.
              </div>
            )}
          </Field>
        </div>
      </div>

      {/* Auto-Label Rules (Phase 2) */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Auto-Label Rules
          <HintIcon text="Configurable rules engine that automatically applies, removes, or toggles labels based on CEL expressions evaluated on issue lifecycle events." />
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <AutoLabelRulesSection companyId={selectedCompanyId} labels={labels ?? []} />
        </div>
      </div>
    </div>
  );
}

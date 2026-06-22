import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ROLES,
  AGENT_ROLE_LABELS,
  ISSUE_PRIORITIES,
  ISSUE_WORK_MODES,
  MODEL_PROFILE_KEYS,
  type ModelProfileKey,
} from "@paperclipai/shared";
import { ArrowDown, ArrowUp, Cpu, Plus, Trash2 } from "lucide-react";
import { modelPoliciesApi, type ModelPolicyRule } from "../api/modelPolicies";
import {
  SIGNAL_KEYS,
  addRule,
  emptyRule,
  isDirty,
  moveRule,
  normalizeRules,
  removeRule,
  setSignal,
  updateRule,
  type SignalKey,
} from "../lib/modelPolicyRules";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PROFILE_LABELS: Record<ModelProfileKey, string> = {
  cheap: "Cheap",
  deep: "Deep",
  bulk: "Bulk",
};

const SIGNAL_LABELS: Record<SignalKey, string> = {
  agentRole: "Agent role",
  wakeReason: "Wake reason",
  issuePriority: "Issue priority",
  workMode: "Work mode",
};

// Known value options per signal. wakeReason has no enum -> free text.
const SIGNAL_OPTIONS: Record<SignalKey, { value: string; label: string }[] | null> = {
  agentRole: AGENT_ROLES.map((role) => ({ value: role, label: AGENT_ROLE_LABELS[role] })),
  issuePriority: ISSUE_PRIORITIES.map((p) => ({ value: p, label: p })),
  workMode: ISSUE_WORK_MODES.map((m) => ({ value: m, label: m })),
  wakeReason: null,
};

export function CompanyModelPolicies() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const policyQuery = useQuery({
    queryKey: queryKeys.modelPolicies.list(selectedCompanyId ?? ""),
    queryFn: () => modelPoliciesApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const loadedRules = policyQuery.data?.rules;
  const [draft, setDraft] = useState<ModelPolicyRule[]>([]);

  // Sync the working copy from the server whenever fresh data arrives.
  useEffect(() => {
    if (loadedRules) setDraft(loadedRules);
  }, [loadedRules]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Company Settings", href: "/company/settings" }, { label: "Model Policies" }]);
  }, [setBreadcrumbs]);

  const dirty = useMemo(
    () => Boolean(loadedRules) && isDirty(draft, loadedRules ?? []),
    [draft, loadedRules],
  );

  const saveMutation = useMutation({
    mutationFn: (rules: ModelPolicyRule[]) => modelPoliciesApi.save(selectedCompanyId!, normalizeRules(rules)),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.modelPolicies.list(selectedCompanyId!),
      });
      setDraft(response.rules);
      pushToast({ tone: "success", title: "Model policy saved", body: "Rules updated for this company." });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Could not save the model policy.",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Cpu} message="Select a company to manage model policies." />;
  }
  if (policyQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }
  if (policyQuery.error) {
    return (
      <div className="px-4 py-6 text-sm text-destructive">
        {policyQuery.error instanceof Error ? policyQuery.error.message : "Failed to load model policies."}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">Model Policies</h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Rules are evaluated top to bottom; the first match selects the model profile. An
            explicit per-issue override still wins over these rules.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => setDraft(loadedRules ?? [])}
          >
            Discard
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? "Saving..." : "Save policy"}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {draft.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No rules yet. Without rules, every task uses the agent's default profile.
          </p>
        ) : (
          <ol className="space-y-3">
            {draft.map((rule, index) => (
              <RuleEditor
                key={index}
                index={index}
                total={draft.length}
                rule={rule}
                onChange={(next) => setDraft((cur) => updateRule(cur, index, next))}
                onRemove={() => setDraft((cur) => removeRule(cur, index))}
                onMove={(dir) => setDraft((cur) => moveRule(cur, index, dir))}
              />
            ))}
          </ol>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="mt-4"
          onClick={() => setDraft((cur) => addRule(cur, emptyRule("cheap")))}
        >
          <Plus className="mr-1 h-4 w-4" /> Add rule
        </Button>
      </div>
    </div>
  );
}

function RuleEditor({
  index,
  total,
  rule,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  rule: ModelPolicyRule;
  onChange: (next: ModelPolicyRule) => void;
  onRemove: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  return (
    <li className="rounded-md border border-border p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Rule {index + 1}</span>
          {rule.reason ? (
            <span className="truncate text-xs text-muted-foreground/80">{rule.reason}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" disabled={index === 0} onClick={() => onMove("up")} aria-label="Move rule up">
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" disabled={index === total - 1} onClick={() => onMove("down")} aria-label="Move rule down">
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Delete rule">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {SIGNAL_KEYS.map((key) => (
          <SignalField
            key={key}
            signalKey={key}
            values={rule.when[key] ?? []}
            onChange={(values) => onChange(setSignal(rule, key, values))}
          />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Model profile</Label>
          <Select
            value={rule.modelProfile}
            onValueChange={(value) => onChange({ ...rule, modelProfile: value as ModelProfileKey })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_PROFILE_KEYS.map((profile) => (
                <SelectItem key={profile} value={profile}>
                  {PROFILE_LABELS[profile]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Reason (optional)</Label>
          <Input
            value={rule.reason ?? ""}
            placeholder="why this rule"
            onChange={(event) =>
              onChange({ ...rule, reason: event.target.value === "" ? undefined : event.target.value })
            }
          />
        </div>
      </div>
    </li>
  );
}

function SignalField({
  signalKey,
  values,
  onChange,
}: {
  signalKey: SignalKey;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const options = SIGNAL_OPTIONS[signalKey];
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{SIGNAL_LABELS[signalKey]}</Label>
      {options ? (
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const active = values.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  onChange(active ? values.filter((v) => v !== opt.value) : [...values, opt.value])
                }
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent/50",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : (
        <Input
          value={values.join(", ")}
          placeholder="comma,separated"
          onChange={(event) =>
            onChange(
              event.target.value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            )
          }
        />
      )}
    </div>
  );
}

export default CompanyModelPolicies;

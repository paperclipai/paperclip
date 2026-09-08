import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueAutoLabelRule, IssueLabel, ProjectAutomationPolicy } from "@paperclipai/shared";
import { Plus, Trash2 } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function newRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function normalizePolicy(policy: ProjectAutomationPolicy | null | undefined): IssueAutoLabelRule[] {
  if (!policy || !Array.isArray(policy.autoLabelRules)) return [];
  return policy.autoLabelRules.filter(
    (rule): rule is IssueAutoLabelRule =>
      !!rule && typeof rule.id === "string" && typeof rule.match === "string" && typeof rule.labelId === "string",
  );
}

export function ProjectAutomationCard({
  companyId,
  projectId,
  automationPolicy,
  onSave,
  isSaving,
}: {
  companyId: string;
  projectId: string;
  automationPolicy: ProjectAutomationPolicy | null | undefined;
  onSave: (policy: ProjectAutomationPolicy) => void;
  isSaving: boolean;
}) {
  const stored = useMemo(() => normalizePolicy(automationPolicy), [automationPolicy]);
  const [drafts, setDrafts] = useState<IssueAutoLabelRule[]>(stored);
  const [matchText, setMatchText] = useState("");
  const [labelId, setLabelId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(stored);
    setError(null);
  }, [stored, projectId]);

  const labelsQuery = useQuery({
    queryKey: queryKeys.issues.labels(companyId),
    queryFn: () => issuesApi.listLabels(companyId),
    enabled: Boolean(companyId),
  });
  const labelsById = useMemo(
    () => new Map((labelsQuery.data ?? []).map((label: IssueLabel) => [label.id, label])),
    [labelsQuery.data],
  );
  const dirty =
    drafts.length !== stored.length ||
    drafts.some((rule, index) => {
      const base = stored[index];
      return !base || base.id !== rule.id || base.match !== rule.match || base.labelId !== rule.labelId;
    });

  const handleAdd = () => {
    const match = matchText.replace(/\s+/g, " ").trim();
    if (match.length === 0) {
      setError("Enter text to match.");
      return;
    }
    if (!labelId) {
      setError("Choose a label.");
      return;
    }
    if (drafts.length >= 25) {
      setError("Rule limit reached. Delete a rule first.");
      return;
    }
    if (drafts.some((rule) => rule.match.toLowerCase() === match.toLowerCase() && rule.labelId === labelId)) {
      setError("That rule already exists.");
      return;
    }
    setDrafts([...drafts, { id: newRuleId(), match, labelId }]);
    setMatchText("");
    setLabelId("");
    setError(null);
  };

  const handleDelete = (id: string) => {
    setDrafts(drafts.filter((rule) => rule.id !== id));
    setError(null);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Automations</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Label new tasks automatically when their title or description contains matching text.
        </p>
      </div>
      {drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rules yet. New tasks keep only their chosen labels.</p>
      ) : (
        <ul className="divide-y divide-border border-y border-border" aria-label="Auto-label rules">
          {drafts.map((rule) => {
            const label = labelsById.get(rule.labelId);
            return (
              <li key={rule.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  “{rule.match}”
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: label?.color ?? "var(--muted)" }}
                  />
                  {label?.name ?? "Deleted label"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  onClick={() => handleDelete(rule.id)}
                  title={`Delete rule for ${rule.match}`}
                  aria-label={`Delete rule for ${rule.match}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={matchText}
          onChange={(event) => setMatchText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleAdd();
          }}
          placeholder="Match text, e.g. outage"
          aria-label="Text to match in new tasks"
          className="h-8 w-44"
          maxLength={120}
        />
        <Select value={labelId} onValueChange={setLabelId}>
          <SelectTrigger className="h-8 w-44" aria-label="Label to apply">
            <SelectValue placeholder="Choose label" />
          </SelectTrigger>
          <SelectContent>
            {(labelsQuery.data ?? []).map((label: IssueLabel) => (
              <SelectItem key={label.id} value={label.id}>
                {label.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" className="h-8 shrink-0" onClick={handleAdd} disabled={isSaving}>
          <Plus className="h-3.5 w-3.5" />
          Add rule
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0"
          disabled={!dirty || isSaving}
          onClick={() => onSave({ autoLabelRules: drafts })}
        >
          {isSaving ? "Saving…" : "Save rules"}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">{error}</p>
      ) : null}
      {dirty ? (
        <p className="text-xs text-muted-foreground">Unsaved changes.</p>
      ) : null}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companyVaultApi, type VaultEntry } from "../api/company-vault";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Lock,
  Eye,
  EyeOff,
  Trash2,
  Plus,
  Key,
  ShieldAlert,
  Copy,
  Check,
} from "lucide-react";

const CATEGORY_LABELS: Record<string, string> = {
  api_key: "API Key",
  llm_key: "LLM Key",
  password: "Password",
  token: "Token",
  other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  api_key: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  llm_key: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  password: "bg-red-500/10 text-red-600 dark:text-red-400",
  token: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  other: "bg-gray-500/10 text-gray-600 dark:text-gray-400",
};

export function CompanyVault() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Company Vault" }]); }, [setBreadcrumbs]);

  const entriesQ = useQuery({
    queryKey: ["company-vault", selectedCompanyId],
    queryFn: () => companyVaultApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const addMutation = useMutation({
    mutationFn: (data: { label: string; category: string; secretValue: string }) =>
      companyVaultApi.add(selectedCompanyId!, data),
    onSuccess: () => {
      pushToast({ title: "Secret added to vault", tone: "success" });
      setAddOpen(false);
      qc.invalidateQueries({ queryKey: ["company-vault", selectedCompanyId] });
    },
    onError: (err) => pushToast({ title: `Failed: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }),
  });

  const removeMutation = useMutation({
    mutationFn: (entryId: string) => companyVaultApi.remove(selectedCompanyId!, entryId),
    onSuccess: () => {
      pushToast({ title: "Secret removed", tone: "success" });
      qc.invalidateQueries({ queryKey: ["company-vault", selectedCompanyId] });
    },
    onError: (err) => pushToast({ title: `Failed: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }),
  });

  async function handleReveal(entryId: string) {
    if (revealedIds.has(entryId)) {
      setRevealedIds((prev) => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
      return;
    }
    try {
      const entry = await companyVaultApi.reveal(selectedCompanyId!, entryId);
      setRevealedValues((prev) => ({ ...prev, [entryId]: entry.secretValue ?? "" }));
      setRevealedIds((prev) => new Set(prev).add(entryId));
    } catch (err) {
      pushToast({ title: `Failed to reveal: ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
    }
  }

  async function handleCopy(entryId: string) {
    const value = revealedValues[entryId];
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedId(entryId);
    setTimeout(() => setCopiedId(null), 2000);
  }

  if (!selectedCompanyId) return null;

  const entries = entriesQ.data ?? [];
  const byCategory = entries.reduce<Record<string, VaultEntry[]>>((acc, e) => {
    const cat = e.category || "other";
    (acc[cat] ??= []).push(e);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2 font-[var(--font-display)] uppercase tracking-[0.06em]">
            <Lock className="h-5 w-5" />
            Company Vault
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Secrets auto-detected from comments and manually added credentials
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Secret
        </Button>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2 rounded-[2px] border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2.5">
        <ShieldAlert className="h-4 w-4 text-[var(--status-warning)] mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">
          Secrets shared in issue comments are automatically detected, redacted from the
          conversation, and stored here. Only board members can view or manage vault entries.
        </p>
      </div>

      {/* Add form */}
      {addOpen && (
        <AddSecretForm
          onAdd={(data) => addMutation.mutate(data)}
          onCancel={() => setAddOpen(false)}
          saving={addMutation.isPending}
        />
      )}

      {/* Empty state */}
      {entries.length === 0 && !entriesQ.isLoading && (
        <div className="text-center py-12">
          <Key className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">
            No secrets in the vault yet. They will appear here when detected in comments
            or added manually.
          </p>
        </div>
      )}

      {/* Entries by category */}
      {Object.entries(byCategory).map(([category, items]) => (
        <div key={category} className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {CATEGORY_LABELS[category] ?? category} ({items.length})
          </h2>
          <div className="space-y-1">
            {items.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 rounded-[2px] border border-border px-3 py-2 hover:bg-[var(--sidebar-accent)] transition-colors"
              >
                <Badge
                  variant="secondary"
                  className={`text-[10px] shrink-0 ${CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS.other}`}
                >
                  {CATEGORY_LABELS[entry.category] ?? entry.category}
                </Badge>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{entry.label}</span>
                    {entry.source === "comment" && (
                      <Badge variant="outline" className="text-[10px]">auto-detected</Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground font-[var(--font-mono)]">
                    {revealedIds.has(entry.id)
                      ? revealedValues[entry.id] ?? entry.maskedPreview
                      : entry.maskedPreview}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {revealedIds.has(entry.id) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => handleCopy(entry.id)}
                    >
                      {copiedId === entry.id ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => handleReveal(entry.id)}
                  >
                    {revealedIds.has(entry.id) ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm("Remove this secret from the vault?")) {
                        removeMutation.mutate(entry.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Secret Form
// ---------------------------------------------------------------------------

function AddSecretForm({
  onAdd,
  onCancel,
  saving,
}: {
  onAdd: (data: { label: string; category: string; secretValue: string }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("other");
  const [secretValue, setSecretValue] = useState("");

  return (
    <div className="rounded-[2px] border border-border p-4 space-y-3 bg-card hud-panel hud-shimmer">
      <h3 className="text-sm font-semibold flex items-center gap-1.5 font-[var(--font-display)] uppercase tracking-[0.06em]">
        <Plus className="h-3.5 w-3.5" /> Add Secret
      </h3>
      <input
        className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
        placeholder="Label (e.g. OpenAI Production Key)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <select
        className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        <option value="api_key">API Key</option>
        <option value="llm_key">LLM Key</option>
        <option value="password">Password</option>
        <option value="token">Token</option>
        <option value="other">Other</option>
      </select>
      <input
        type="password"
        className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
        placeholder="Secret value"
        value={secretValue}
        onChange={(e) => setSecretValue(e.target.value)}
      />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!label || !secretValue || saving}
          onClick={() => onAdd({ label, category, secretValue })}
        >
          {saving ? "Saving..." : "Add to Vault"}
        </Button>
      </div>
    </div>
  );
}

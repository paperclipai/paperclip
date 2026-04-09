/**
 * Recruiting page — Phase 5.2e.
 *
 * Propose + track new agent hires. Wraps the existing `hire_agent`
 * approval flow so a board user can submit a candidate spec through a
 * simple form instead of crafting the approval payload by hand.
 *
 * Page structure:
 *   1. Header + "Propose new agent" toggle
 *   2. Inline propose form (name, role, title, capabilities,
 *      adapterType, budget, reason)
 *   3. Pending hires list — filtered to `approvals.type === "hire_agent"`
 *      and `status IN (pending, revision_requested)`. Each row renders
 *      with ApprovalCard so approve/reject work exactly like the
 *      global Approvals page.
 *   4. Recently hired (non-pending hire_agent approvals) shown below
 *      the divider so users can see what their company has been
 *      building out.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Plus, X } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { recruitingApi } from "../api/recruiting";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApprovalCard } from "../components/ApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";

const ADAPTER_OPTIONS = [
  { value: "claude_local", label: "Leader (claude_local, CLI)" },
  { value: "process", label: "Sub-agent (process)" },
  { value: "none", label: "None" },
] as const;

export function Recruiting() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const qc = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Recruiting" }]);
  }, [setBreadcrumbs]);

  const { data: approvals, isLoading } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const hires = useMemo(
    () => (approvals ?? []).filter((a) => a.type === "hire_agent"),
    [approvals],
  );
  const pendingHires = useMemo(
    () => hires.filter((a) => a.status === "pending" || a.status === "revision_requested"),
    [hires],
  );
  const decidedHires = useMemo(
    () =>
      hires
        .filter((a) => a.status === "approved" || a.status === "rejected")
        .sort(
          (a, b) =>
            new Date(b.decidedAt ?? b.updatedAt).getTime() -
            new Date(a.decidedAt ?? a.updatedAt).getTime(),
        )
        .slice(0, 10),
    [hires],
  );

  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [title, setTitle] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [adapterType, setAdapterType] = useState<"claude_local" | "process" | "none">("process");
  const [budget, setBudget] = useState("0");
  const [reason, setReason] = useState("");
  // Reviewer P1 finding (feature-dev #3): track which approval is in
  // flight so the pending state only disables THAT card, not every
  // card in the list.
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);

  const resetForm = () => {
    setName("");
    setRole("");
    setTitle("");
    setCapabilities("");
    setAdapterType("process");
    setBudget("0");
    setReason("");
    setFormError(null);
  };

  const proposeMutation = useMutation({
    mutationFn: () => {
      // Finite-number guard so `Number("1e999")` → Infinity doesn't
      // propagate to the server (which would reject with 400 anyway,
      // but fail fast locally).
      const n = Number(budget);
      const cents = Number.isFinite(n) ? Math.max(0, Math.floor(n * 100)) : 0;
      return recruitingApi.propose(selectedCompanyId!, {
        name: name.trim(),
        role: role.trim(),
        title: title.trim() || null,
        capabilities: capabilities.trim() || null,
        adapterType,
        budgetMonthlyCents: cents,
        reason: reason.trim() || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      setFormOpen(false);
      resetForm();
    },
    onError: (err: any) => {
      setFormError(err?.message ?? "Failed to propose hire");
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => {
      setPendingApprovalId(id);
      return approvalsApi.approve(id);
    },
    onSettled: () => setPendingApprovalId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
    },
  });
  const rejectMutation = useMutation({
    mutationFn: (id: string) => {
      setPendingApprovalId(id);
      return approvalsApi.reject(id);
    },
    onSettled: () => setPendingApprovalId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  if (isLoading && !approvals) return <PageSkeleton variant="list" />;

  const canSubmit =
    name.trim().length > 0 && role.trim().length > 0 && !proposeMutation.isPending;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <UserPlus className="h-5 w-5" /> Recruiting
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Propose new agents, review hiring approvals, and track who you've
            brought on recently.
          </p>
        </div>
        {!formOpen && (
          <Button size="sm" onClick={() => setFormOpen(true)}>
            <Plus className="h-3 w-3 mr-1" /> Propose new agent
          </Button>
        )}
      </div>

      {formOpen && (
        <div className="p-4 border border-border rounded-lg bg-accent/10 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">New agent proposal</h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFormOpen(false);
                resetForm();
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[11px] text-muted-foreground">Name *</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Performance Specialist"
                className="h-8 text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Role *</label>
              <Input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="qa_engineer"
                className="h-8 text-sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Staff Performance Engineer"
                className="h-8 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="text-[11px] text-muted-foreground">Capabilities</label>
              <Textarea
                value={capabilities}
                onChange={(e) => setCapabilities(e.target.value)}
                placeholder="What does this agent do? Comma-separated strengths."
                className="min-h-[60px] text-xs"
              />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Adapter type</label>
              <Select
                value={adapterType}
                onValueChange={(v) => setAdapterType(v as typeof adapterType)}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADAPTER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Monthly budget (USD)</label>
              <Input
                type="number"
                min="0"
                step="10"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="text-[11px] text-muted-foreground">Why we need this hire</label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reasoning for the approver…"
                className="min-h-[50px] text-xs"
              />
            </div>
          </div>

          {formError && <p className="text-xs text-destructive">{formError}</p>}

          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFormOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => proposeMutation.mutate()}>
              Submit for approval
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-medium">
          Pending hires{" "}
          {pendingHires.length > 0 && (
            <span className="ml-1 rounded-full bg-yellow-500/20 text-yellow-500 px-1.5 py-0.5 text-[10px] font-medium">
              {pendingHires.length}
            </span>
          )}
        </h2>
        {pendingHires.length === 0 ? (
          <EmptyState icon={UserPlus} message="No pending hires. Propose someone above." />
        ) : (
          <div className="grid gap-3">
            {pendingHires.map((a) => {
              const isThisCardPending = pendingApprovalId === a.id;
              return (
                <ApprovalCard
                  key={a.id}
                  approval={a}
                  requesterAgent={
                    a.requestedByAgentId
                      ? (agents ?? []).find((x) => x.id === a.requestedByAgentId) ?? null
                      : null
                  }
                  onApprove={() => approveMutation.mutate(a.id)}
                  onReject={() => rejectMutation.mutate(a.id)}
                  detailLink={`/approvals/${a.id}`}
                  isPending={isThisCardPending}
                  pendingAction={
                    !isThisCardPending
                      ? null
                      : approveMutation.isPending
                      ? "approve"
                      : rejectMutation.isPending
                      ? "reject"
                      : null
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {decidedHires.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Recently decided</h2>
          <div className="grid gap-2">
            {decidedHires.map((a) => {
              const payload = (a.payload ?? {}) as Record<string, unknown>;
              const name = typeof payload.name === "string" ? payload.name : "(unnamed)";
              const role = typeof payload.role === "string" ? payload.role : "";
              return (
                <div
                  key={a.id}
                  className="flex items-center gap-3 px-3 py-2 border border-border rounded text-xs"
                >
                  <span
                    className={
                      a.status === "approved"
                        ? "px-1.5 py-0.5 rounded bg-green-500/15 text-green-600 text-[10px] font-medium"
                        : "px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 text-[10px] font-medium"
                    }
                  >
                    {a.status}
                  </span>
                  <span className="flex-1 truncate font-medium">{name}</span>
                  <span className="text-muted-foreground truncate">{role}</span>
                  <span className="text-muted-foreground shrink-0">
                    {a.decidedAt ? new Date(a.decidedAt).toLocaleDateString() : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

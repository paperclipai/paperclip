import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { hiringApi } from "../api/hiring";
import { roleTemplatesApi, type RoleTemplate } from "../api/roleTemplates";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  Clock,
  ArrowLeft,
  ArrowRight,
  Check,
  BookTemplate,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AGENT_ROLE_LABELS,
  AGENT_ROLES,
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  CONTRACT_END_CONDITIONS,
  type AgentRole,
  type Department,
  type ContractEndCondition,
} from "@ironworksai/shared";

type EmploymentType = "full_time" | "contractor";
type Step = 1 | 2 | 3;

const END_CONDITION_LABELS: Record<ContractEndCondition, string> = {
  date: "By Date",
  project_complete: "When Project Completes",
  budget_exhausted: "When Budget Exhausted",
  manual: "Manual",
};

export function HireAgentDialog() {
  const { hireAgentOpen, closeHireAgent } = useDialog();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>(1);
  const [employmentType, setEmploymentType] = useState<EmploymentType | null>(null);

  // Step 2 fields
  const [name, setName] = useState("");
  const [role, setRole] = useState<AgentRole>("engineer");
  const [department, setDepartment] = useState<Department>("engineering");
  const [reportsTo, setReportsTo] = useState<string>("");
  const [showTalentPool, setShowTalentPool] = useState(false);

  // Contractor fields
  const [projectId, setProjectId] = useState<string>("");
  const [endCondition, setEndCondition] = useState<ContractEndCondition>("manual");
  const [endDate, setEndDate] = useState("");
  const [budgetAmount, setBudgetAmount] = useState("");

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && hireAgentOpen,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && hireAgentOpen && employmentType === "contractor",
  });

  const { data: templates } = useQuery({
    queryKey: queryKeys.roleTemplates.list(selectedCompanyId!),
    queryFn: () => roleTemplatesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && hireAgentOpen && showTalentPool,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      hiringApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hiring.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.headcount(selectedCompanyId!) });
    },
  });

  const fulfillMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      hiringApi.fulfill(selectedCompanyId!, id, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hiring.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.headcount(selectedCompanyId!) });
    },
  });

  function resetState() {
    setStep(1);
    setEmploymentType(null);
    setName("");
    setRole("engineer");
    setDepartment("engineering");
    setReportsTo("");
    setShowTalentPool(false);
    setProjectId("");
    setEndCondition("manual");
    setEndDate("");
    setBudgetAmount("");
  }

  function handleClose() {
    resetState();
    closeHireAgent();
  }

  function handleTypeSelect(type: EmploymentType) {
    setEmploymentType(type);
    setStep(2);
  }

  function handleTemplateSelect(t: RoleTemplate) {
    setName(t.title);
    setRole(t.role as AgentRole);
    if (t.department) setDepartment(t.department as Department);
    if (t.employmentType === "contractor" || t.employmentType === "full_time") {
      setEmploymentType(t.employmentType as EmploymentType);
    }
    setShowTalentPool(false);
  }

  function buildPayload(status: string) {
    const payload: Record<string, unknown> = {
      title: name.trim(),
      role,
      department,
      employmentType,
      status,
      reportsToAgentId: reportsTo || null,
    };
    if (employmentType === "contractor") {
      payload.projectId = projectId || null;
      payload.endCondition = endCondition;
      if (endCondition === "date" && endDate) {
        payload.endDate = endDate;
      }
      if (endCondition === "budget_exhausted" && budgetAmount) {
        payload.budgetCents = Math.round(parseFloat(budgetAmount) * 100);
      }
    }
    return payload;
  }

  async function handleSubmitForApproval() {
    try {
      await createMutation.mutateAsync(buildPayload("pending"));
      pushToast({ title: "Hiring request submitted", body: "Awaiting approval.", tone: "success" });
      handleClose();
    } catch (err) {
      pushToast({ title: "Failed to submit", body: err instanceof Error ? err.message : "Unknown error", tone: "error" });
    }
  }

  async function handleHireNow() {
    try {
      const req = await createMutation.mutateAsync(buildPayload("approved"));
      await fulfillMutation.mutateAsync({ id: req.id });
      pushToast({ title: "Agent hired", body: `${name} has been added to the team.`, tone: "success" });
      handleClose();
    } catch (err) {
      pushToast({ title: "Failed to hire", body: err instanceof Error ? err.message : "Unknown error", tone: "error" });
    }
  }

  const canProceedToReview =
    name.trim().length > 0 &&
    (employmentType !== "contractor" || projectId);

  const isPending = createMutation.isPending || fulfillMutation.isPending;

  return (
    <Dialog
      open={hireAgentOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-lg p-0 gap-0 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2">
            {step > 1 && (
              <button
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  if (showTalentPool) {
                    setShowTalentPool(false);
                    return;
                  }
                  setStep((step - 1) as Step);
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <span className="text-sm text-muted-foreground">
              {step === 1 && "Hire Agent - Employment Type"}
              {step === 2 && (showTalentPool ? "Select from Talent Pool" : "Hire Agent - Configuration")}
              {step === 3 && "Hire Agent - Review"}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={handleClose}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-4">
          {/* Step 1: Employment Type */}
          {step === 1 && (
            <div className="grid grid-cols-2 gap-3">
              <button
                className={cn(
                  "flex flex-col items-center gap-3 rounded-md border border-border p-5 text-sm transition-colors hover:bg-accent/50",
                  employmentType === "full_time" && "border-foreground bg-accent/30",
                )}
                onClick={() => handleTypeSelect("full_time")}
              >
                <Users className="h-8 w-8 text-blue-500" />
                <span className="font-medium">Full-Time Employee</span>
                <span className="text-xs text-muted-foreground text-center">
                  Permanent team member. Accumulates institutional knowledge. Grows with the company.
                </span>
              </button>
              <button
                className={cn(
                  "flex flex-col items-center gap-3 rounded-md border border-border p-5 text-sm transition-colors hover:bg-accent/50",
                  employmentType === "contractor" && "border-foreground bg-accent/30",
                )}
                onClick={() => handleTypeSelect("contractor")}
              >
                <Clock className="h-8 w-8 text-amber-500" />
                <span className="font-medium">Contractor</span>
                <span className="text-xs text-muted-foreground text-center">
                  Project-scoped. Auto-terminates when the engagement ends. Fast onboarding with context packet.
                </span>
              </button>
            </div>
          )}

          {/* Step 2: Configuration */}
          {step === 2 && !showTalentPool && (
            <div className="space-y-4">
              {/* Name */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Name *</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Agent name"
                  className="text-sm"
                />
              </div>

              {/* Role */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as AgentRole)}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                >
                  {AGENT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {(AGENT_ROLE_LABELS as Record<string, string>)[r] ?? r}
                    </option>
                  ))}
                </select>
              </div>

              {/* Department */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Department</label>
                <select
                  value={department}
                  onChange={(e) => setDepartment(e.target.value as Department)}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                >
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {(DEPARTMENT_LABELS as Record<string, string>)[d] ?? d}
                    </option>
                  ))}
                </select>
              </div>

              {/* Reports To */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Reports To</label>
                <select
                  value={reportsTo}
                  onChange={(e) => setReportsTo(e.target.value)}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                >
                  <option value="">None</option>
                  {(agents ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({(AGENT_ROLE_LABELS as Record<string, string>)[a.role] ?? a.role})
                    </option>
                  ))}
                </select>
              </div>

              {/* Talent Pool button */}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setShowTalentPool(true)}
              >
                <BookTemplate className="h-3.5 w-3.5 mr-1.5" />
                Select from Talent Pool
              </Button>

              {/* Contractor-specific fields */}
              {employmentType === "contractor" && (
                <div className="space-y-4 border-t border-border pt-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Contract Details
                  </div>

                  {/* Project */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Project *</label>
                    <select
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    >
                      <option value="">Select a project</option>
                      {(projects ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* End Condition */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">End Condition</label>
                    <div className="space-y-1">
                      {CONTRACT_END_CONDITIONS.map((ec) => (
                        <label key={ec} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="endCondition"
                            value={ec}
                            checked={endCondition === ec}
                            onChange={() => setEndCondition(ec)}
                            className="accent-foreground"
                          />
                          {END_CONDITION_LABELS[ec]}
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Date picker for "date" condition */}
                  {endCondition === "date" && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">End Date</label>
                      <Input
                        type="date"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        className="text-sm"
                      />
                    </div>
                  )}

                  {/* Budget for "budget_exhausted" condition */}
                  {endCondition === "budget_exhausted" && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Budget Amount ($)</label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={budgetAmount}
                        onChange={(e) => setBudgetAmount(e.target.value)}
                        placeholder="0.00"
                        className="text-sm"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Next button */}
              <Button
                className="w-full"
                disabled={!canProceedToReview}
                onClick={() => setStep(3)}
              >
                Review
                <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </div>
          )}

          {/* Talent Pool overlay */}
          {step === 2 && showTalentPool && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Select a role template to pre-fill the configuration form.
              </p>
              {(templates ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No role templates available. Create templates in Company Settings.
                </p>
              )}
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {(templates ?? []).map((t) => (
                  <button
                    key={t.id}
                    className="w-full text-left rounded-md border border-border p-3 hover:bg-accent/50 transition-colors"
                    onClick={() => handleTemplateSelect(t)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{t.title}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {(EMPLOYMENT_TYPE_LABELS as Record<string, string>)[t.employmentType] ?? t.employmentType}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">
                        {(AGENT_ROLE_LABELS as Record<string, string>)[t.role] ?? t.role}
                      </span>
                      {t.department && (
                        <>
                          <span className="text-border">|</span>
                          <span className="text-xs text-muted-foreground">
                            {(DEPARTMENT_LABELS as Record<string, string>)[t.department] ?? t.department}
                          </span>
                        </>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-xs text-muted-foreground/70 mt-1">{t.description}</p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Review & Submit */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="rounded-md border border-border p-4 space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Summary
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium">{name}</span>

                  <span className="text-muted-foreground">Type</span>
                  <span className="font-medium">
                    {employmentType === "full_time" ? "Full-Time Employee" : "Contractor"}
                  </span>

                  <span className="text-muted-foreground">Role</span>
                  <span className="font-medium">
                    {(AGENT_ROLE_LABELS as Record<string, string>)[role] ?? role}
                  </span>

                  <span className="text-muted-foreground">Department</span>
                  <span className="font-medium">
                    {(DEPARTMENT_LABELS as Record<string, string>)[department] ?? department}
                  </span>

                  {reportsTo && (
                    <>
                      <span className="text-muted-foreground">Reports To</span>
                      <span className="font-medium">
                        {(agents ?? []).find((a) => a.id === reportsTo)?.name ?? reportsTo}
                      </span>
                    </>
                  )}

                  {employmentType === "contractor" && (
                    <>
                      <span className="text-muted-foreground">Project</span>
                      <span className="font-medium">
                        {(projects ?? []).find((p) => p.id === projectId)?.name ?? projectId}
                      </span>

                      <span className="text-muted-foreground">End Condition</span>
                      <span className="font-medium">{END_CONDITION_LABELS[endCondition]}</span>

                      {endCondition === "date" && endDate && (
                        <>
                          <span className="text-muted-foreground">End Date</span>
                          <span className="font-medium">{endDate}</span>
                        </>
                      )}

                      {endCondition === "budget_exhausted" && budgetAmount && (
                        <>
                          <span className="text-muted-foreground">Budget</span>
                          <span className="font-medium">${budgetAmount}</span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={handleSubmitForApproval}
                  disabled={isPending}
                >
                  {createMutation.isPending && !fulfillMutation.isPending
                    ? "Submitting..."
                    : "Submit for Approval"}
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleHireNow}
                  disabled={isPending}
                >
                  {isPending ? "Hiring..." : "Hire Now"}
                  <Check className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>

              {(createMutation.isError || fulfillMutation.isError) && (
                <p className="text-xs text-destructive text-center">
                  {(createMutation.error ?? fulfillMutation.error)?.message ?? "An error occurred"}
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

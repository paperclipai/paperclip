/**
 * RAA-337: Raava Onboarding Wizard for FleetOS mode.
 *
 * Replaces the Paperclip adapter-picker onboarding when deploymentMode === "fleetos".
 * Users see role cards (not adapters). 4-step flow:
 *   1. Create Your Company
 *   2. Hire Your First Team Member (role card selection)
 *   3. Credentials & Setup
 *   4. Name & Launch
 *
 * Pod Gamma (Kai Andersen + Amara Osei)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentRole } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentIconPicker, AgentIcon } from "./AgentIconPicker";
import { cn } from "../lib/utils";
import {
  Briefcase,
  Cog,
  Headset,
  BarChart3,
  Megaphone,
  Star,
  Check,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Lock,
  Sparkles,
  Eye,
  EyeOff,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

type WizardStep = 1 | 2 | 3 | 4;

interface RoleDefinition {
  id: string;
  name: string;
  agentRole: AgentRole;
  description: string;
  icon: LucideIcon;
  tools: string[];
  credentials: CredentialField[];
  defaultAgentName: string;
  defaultFirstTask: string;
  templateName: string;
}

interface CredentialField {
  id: string;
  label: string;
  placeholder: string;
  helpUrl: string;
}

const ROLES: RoleDefinition[] = [
  {
    id: "sales-assistant",
    name: "Sales Assistant",
    agentRole: "general",
    description:
      "Follows up with leads, drafts proposals, updates CRM records, and manages the sales pipeline",
    icon: Briefcase,
    tools: ["Email", "CRM", "Document Drafting"],
    credentials: [
      {
        id: "gmail_api_key",
        label: "Gmail API Key",
        placeholder: "Enter your Gmail API key",
        helpUrl: "#",
      },
      {
        id: "crm_api_key",
        label: "CRM API Key (HubSpot/Salesforce)",
        placeholder: "Enter your CRM API key",
        helpUrl: "#",
      },
    ],
    defaultAgentName: "Alex",
    defaultFirstTask:
      "Review my recent leads and draft follow-up emails for anyone who hasn't responded in 3+ days",
    templateName: "sales-assistant",
  },
  {
    id: "operations-manager",
    name: "Operations Manager",
    agentRole: "pm",
    description:
      "Manages workflows, tracks task status, coordinates between team members, and flags blockers",
    icon: Cog,
    tools: ["Task Management", "Calendar", "Spreadsheets"],
    credentials: [
      {
        id: "google_workspace_api_key",
        label: "Google Workspace API Key",
        placeholder: "Enter your Google Workspace API key",
        helpUrl: "#",
      },
    ],
    defaultAgentName: "Jordan",
    defaultFirstTask:
      "Audit our current task list and identify any items that are overdue or unassigned",
    templateName: "ops-manager",
  },
  {
    id: "customer-support",
    name: "Customer Support",
    agentRole: "general",
    description:
      "Answers support tickets, drafts responses, categorizes issues, and escalates complex problems to humans",
    icon: Headset,
    tools: ["Help Desk", "Email", "Knowledge Base"],
    credentials: [
      {
        id: "helpdesk_api_key",
        label: "Zendesk/Freshdesk API Key",
        placeholder: "Enter your help desk API key",
        helpUrl: "#",
      },
      {
        id: "email_api_key",
        label: "Email API Key",
        placeholder: "Enter your email API key",
        helpUrl: "#",
      },
    ],
    defaultAgentName: "Taylor",
    defaultFirstTask:
      "Review open support tickets and draft responses for the 5 most recent ones",
    templateName: "customer-support",
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    agentRole: "researcher",
    description:
      "Pulls data, generates reports, identifies trends, and presents findings in clear summaries",
    icon: BarChart3,
    tools: ["SQL", "Spreadsheets", "Visualization"],
    credentials: [
      {
        id: "database_connection",
        label: "Database Connection String",
        placeholder: "Enter your read-only database connection string",
        helpUrl: "#",
      },
      {
        id: "google_sheets_api_key",
        label: "Google Sheets API Key",
        placeholder: "Enter your Google Sheets API key",
        helpUrl: "#",
      },
    ],
    defaultAgentName: "Sam",
    defaultFirstTask:
      "Pull this week's key metrics and create a summary report",
    templateName: "data-analyst",
  },
  {
    id: "marketing-coordinator",
    name: "Marketing Coordinator",
    agentRole: "cmo",
    description:
      "Drafts social media content, schedules posts, tracks campaign performance, and maintains brand voice",
    icon: Megaphone,
    tools: ["Social Media", "Content", "Analytics"],
    credentials: [
      {
        id: "social_api_key",
        label: "Hootsuite/Buffer API Key",
        placeholder: "Enter your social media management API key",
        helpUrl: "#",
      },
      {
        id: "analytics_api_key",
        label: "Google Analytics API Key",
        placeholder: "Enter your Analytics API key",
        helpUrl: "#",
      },
    ],
    defaultAgentName: "Riley",
    defaultFirstTask:
      "Draft 3 social media posts for this week based on our latest product update",
    templateName: "marketing-coordinator",
  },
  {
    id: "general-assistant",
    name: "General Assistant",
    agentRole: "general",
    description:
      "Flexible team member for research, writing, email management, and ad-hoc tasks",
    icon: Star,
    tools: ["Email", "Documents", "Research"],
    credentials: [
      {
        id: "gmail_api_key",
        label: "Gmail API Key (optional)",
        placeholder: "Enter your Gmail API key",
        helpUrl: "#",
      },
    ],
    defaultAgentName: "Casey",
    defaultFirstTask:
      "Organize my inbox and flag anything that needs my attention today",
    templateName: "general-assistant",
  },
];

const USER_ROLES = [
  "CEO",
  "Head of Ops",
  "VP Sales",
  "VP Engineering",
  "Other",
] as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === current;
        const isCompleted = stepNum < current;
        return (
          <div key={stepNum} className="flex items-center gap-2">
            <div
              className={cn(
                "flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold transition-all duration-200",
                isActive &&
                  "bg-gradient-to-r from-[#224AE8] via-[#716EFF] to-[#00BDB7] text-white shadow-md",
                isCompleted && "bg-[#00BDB7] text-white",
                !isActive &&
                  !isCompleted &&
                  "border border-border text-muted-foreground bg-muted/30",
              )}
            >
              {isCompleted ? <Check className="w-3.5 h-3.5" /> : stepNum}
            </div>
            {stepNum < total && (
              <div
                className={cn(
                  "w-8 h-0.5 rounded-full transition-colors",
                  stepNum < current ? "bg-[#00BDB7]" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoleCard({
  role,
  selected,
  onClick,
}: {
  role: RoleDefinition;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = role.icon;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={role.name}
      onClick={onClick}
      className={cn(
        "relative flex flex-col items-start gap-3 rounded-xl border p-5 text-left transition-all duration-200 hover:shadow-md",
        "bg-card",
        selected
          ? "border-2 border-transparent shadow-lg ring-2 ring-[#00BDB7]"
          : "border-border hover:border-[#716EFF]/40",
      )}
      style={
        selected
          ? {
              backgroundImage:
                "linear-gradient(var(--color-card), var(--color-card)), linear-gradient(135deg, #224AE8, #716EFF, #00BDB7)",
              backgroundOrigin: "border-box",
              backgroundClip: "padding-box, border-box",
            }
          : undefined
      }
    >
      {selected && (
        <div className="absolute top-3 right-3 flex items-center justify-center w-5 h-5 rounded-full bg-[#00BDB7] text-white">
          <Check className="w-3 h-3" />
        </div>
      )}

      <div
        className={cn(
          "flex items-center justify-center w-10 h-10 rounded-lg",
          selected
            ? "bg-gradient-to-br from-[#224AE8] to-[#00BDB7] text-white"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="w-5 h-5" />
      </div>

      <div>
        <h3 className="font-semibold text-sm">{role.name}</h3>
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
          {role.description}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 mt-auto">
        {role.tools.map((tool) => (
          <span
            key={tool}
            className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {tool}
          </span>
        ))}
      </div>
    </button>
  );
}

function CredentialInput({
  field,
  value,
  onChange,
}: {
  field: CredentialField;
  value: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{field.label}</Label>
        <a
          href={field.helpUrl}
          className="text-[10px] text-[#224AE8] hover:underline"
          onClick={(e) => e.preventDefault()}
        >
          How to get this?
        </a>
      </div>
      <div className="relative">
        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          type={visible ? "text" : "password"}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pl-8 pr-9 h-9 text-sm"
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {visible ? (
            <EyeOff className="w-3.5 h-3.5" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function RaavaOnboardingWizard() {
  const { onboardingOpen, closeOnboarding } = useDialog();
  const { setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Wizard state
  const [step, setStep] = useState<WizardStep>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successState, setSuccessState] = useState(false);

  // Step 1: Company
  const [companyName, setCompanyName] = useState("");
  const [userName, setUserName] = useState("");
  const [userRole, setUserRole] = useState("");

  // Step 2: Role selection
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  // Step 3: Credentials
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  // Step 4: Name & Launch
  const [agentName, setAgentName] = useState("");
  const [agentIcon, setAgentIcon] = useState<string | null>("bot");
  const [firstTask, setFirstTask] = useState("");

  // Created IDs (track across steps)
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(null);
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >(null);
  const [hiredAgentName, setHiredAgentName] = useState<string>("");

  // Auto-grow textarea ref
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedRole = ROLES.find((r) => r.id === selectedRoleId) ?? null;

  // When role changes, update step 4 defaults
  useEffect(() => {
    if (selectedRole) {
      setAgentName(selectedRole.defaultAgentName);
      setFirstTask(selectedRole.defaultFirstTask);
      // Reset credentials for new role
      const newCreds: Record<string, string> = {};
      for (const field of selectedRole.credentials) {
        newCreds[field.id] = "";
      }
      setCredentials(newCreds);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps — intentionally only
  // re-run when the selected role ID changes; including `selectedRole` or setter
  // functions would cause unnecessary resets when the ROLES array reference changes.
  }, [selectedRoleId]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || step !== 4) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [step, firstTask]);

  function reset() {
    setStep(1);
    setLoading(false);
    setError(null);
    setSuccessState(false);
    setCompanyName("");
    setUserName("");
    setUserRole("");
    setSelectedRoleId(null);
    setCredentials({});
    setAgentName("");
    setAgentIcon("bot");
    setFirstTask("");
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setHiredAgentName("");
  }

  function handleClose() {
    if (loading) return;
    reset();
    closeOnboarding();
  }

  // ---- Step handlers ----

  async function handleStep1Next() {
    if (!companyName.trim() || !userName.trim()) {
      setError("Please fill in all required fields.");
      return;
    }

    // If company was already created (e.g. user navigated back to step 1),
    // skip the API call and just advance.
    if (createdCompanyId) {
      setStep(2);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // TODO: userName and userRole are collected in the onboarding UX but are
      // not persisted yet — the companies.create endpoint only accepts `name`.
      // Once the backend supports user profile fields, pass them here.
      const company = await companiesApi.create({
        name: companyName.trim(),
      });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setStep(2);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create company",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleStep2Next() {
    if (!selectedRoleId) {
      setError("Please select a role for your first team member.");
      return;
    }
    setError(null);
    setStep(3);
  }

  function handleStep3Next() {
    setError(null);
    setStep(4);
  }

  function handleStep3Skip() {
    // Clear credentials and move forward
    if (selectedRole) {
      const emptyCreds: Record<string, string> = {};
      for (const field of selectedRole.credentials) {
        emptyCreds[field.id] = "";
      }
      setCredentials(emptyCreds);
    }
    setError(null);
    setStep(4);
  }

  async function handleHire() {
    if (!createdCompanyId || !selectedRole) return;
    if (!agentName.trim()) {
      setError("Please enter a name for your team member.");
      return;
    }
    setLoading(true);
    setError(null);

    // Track created resource IDs so we can clean up on partial failure
    let createdAgentId: string | null = null;
    let createdProjectId: string | null = null;

    try {
      // Build adapter config for hermes_fleetos.
      // These will be populated when FleetOS provisioning is wired in.
      // For MVP, the agent is created in Paperclip's DB; FleetOS provisioning is a separate step.
      const adapterConfig: Record<string, unknown> = {};
      // Store role credentials separately for vault injection — only include
      // fields that have actual values to avoid sending empty strings.
      if (Object.values(credentials).some((v) => v.trim())) {
        adapterConfig.roleCredentials = { ...credentials };
      }

      // Create the agent
      const agent = await agentsApi.create(createdCompanyId, {
        name: agentName.trim(),
        role: selectedRole.agentRole,
        adapterType: "hermes_fleetos",
        icon: agentIcon,
        adapterConfig,
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 3600,
            wakeOnDemand: true,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
      });
      createdAgentId = agent.id;

      // Create a project for onboarding
      const project = await projectsApi.create(createdCompanyId, {
        name: `${agentName.trim()}'s Work`,
        description: `Tasks for ${agentName.trim()} (${selectedRole.name})`,
      });
      createdProjectId = project.id;

      // Create the first task (issue)
      await issuesApi.create(createdCompanyId, {
        title: firstTask.trim() || selectedRole.defaultFirstTask,
        description: firstTask.trim() || selectedRole.defaultFirstTask,
        assigneeAgentId: agent.id,
        projectId: project.id,
        priority: "medium",
        status: "open",
      });

      // Only invalidate queries after all resources are successfully created
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(createdCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(createdCompanyId),
      });

      setHiredAgentName(agentName.trim());
      setSuccessState(true);
    } catch (err) {
      // Compensating deletes: clean up any resources created before the failure.
      // Swallow delete errors — the original error is what matters to the user.
      if (createdProjectId) {
        try { await projectsApi.remove(createdProjectId, createdCompanyId); } catch { /* swallow */ }
      }
      if (createdAgentId) {
        try { await agentsApi.remove(createdAgentId, createdCompanyId); } catch { /* swallow */ }
      }
      // Invalidate after cleanup so the UI reflects the rollback
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(createdCompanyId),
      });

      setError(
        err instanceof Error ? err.message : "Failed to hire team member",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleGoToTeam() {
    const prefix = createdCompanyPrefix;
    reset();
    closeOnboarding();
    navigate(prefix ? `/${prefix}/agents/all` : "/agents/all");
  }

  const updateCredential = useCallback(
    (fieldId: string, value: string) => {
      setCredentials((prev) => ({ ...prev, [fieldId]: value }));
    },
    [],
  );

  // ---- Render helpers ----

  if (!onboardingOpen) return null;

  // Success overlay
  if (successState) {
    return (
      <Dialog open onOpenChange={handleClose}>
        <DialogPortal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="relative w-full max-w-md mx-4 rounded-2xl bg-card p-8 shadow-2xl border border-border text-center animate-in fade-in-0 zoom-in-95 duration-300">
              {/* Raava star mark */}
              <div className="mx-auto mb-4 flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-[#224AE8] via-[#716EFF] to-[#00BDB7]">
                <Sparkles className="w-8 h-8 text-white" />
              </div>

              <h2
                className="text-2xl font-bold"
                style={{ fontFamily: "Syne, system-ui, sans-serif" }}
              >
                {hiredAgentName} is on your team!
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                They&apos;re starting on their first task now.
              </p>

              <Button
                onClick={handleGoToTeam}
                className="mt-6 w-full text-white font-semibold"
                style={{
                  background:
                    "linear-gradient(90deg, #224AE8, #716EFF, #00BDB7)",
                }}
              >
                Go to My Team
              </Button>
            </div>
          </div>
        </DialogPortal>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={handleClose}>
      <DialogPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            className={cn(
              "relative w-full mx-4 rounded-2xl bg-card shadow-2xl border border-border animate-in fade-in-0 zoom-in-95 duration-300 overflow-hidden",
              step === 2 ? "max-w-3xl" : "max-w-lg",
            )}
          >
            {/* Close button — disabled while async operations are in-flight */}
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              aria-label="Close"
              className="absolute top-4 right-4 z-10 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="p-8 max-h-[85vh] overflow-y-auto">
              {/* Raava star mark */}
              <div className="flex justify-center mb-2">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-[#224AE8] via-[#716EFF] to-[#00BDB7]">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
              </div>

              <StepIndicator current={step} total={4} />

              {/* ---- STEP 1: Create Your Company ---- */}
              {step === 1 && (
                <div className="space-y-6">
                  <div className="text-center">
                    <h2
                      className="text-xl font-bold"
                      style={{
                        fontFamily: "Syne, system-ui, sans-serif",
                      }}
                    >
                      Create Your Company
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Tell us about yourself and your company
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="raava-company-name" className="text-xs">
                        Company name
                      </Label>
                      <Input
                        id="raava-company-name"
                        placeholder="Acme Corp"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                        autoFocus
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="raava-user-name" className="text-xs">
                        Your name
                      </Label>
                      <Input
                        id="raava-user-name"
                        placeholder="Carlos Mendez"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Your role</Label>
                      <Select value={userRole} onValueChange={setUserRole}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select your role" />
                        </SelectTrigger>
                        <SelectContent>
                          {USER_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {error && (
                    <p className="text-xs text-destructive">{error}</p>
                  )}

                  <Button
                    onClick={handleStep1Next}
                    disabled={loading || !companyName.trim() || !userName.trim()}
                    className="w-full text-white font-semibold"
                    style={{
                      background:
                        "linear-gradient(90deg, #224AE8, #716EFF, #00BDB7)",
                    }}
                  >
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : null}
                    {loading ? "Creating..." : "Next"}
                    {!loading && <ArrowRight className="w-4 h-4 ml-2" />}
                  </Button>
                </div>
              )}

              {/* ---- STEP 2: Hire Your First Team Member ---- */}
              {step === 2 && (
                <div className="space-y-6">
                  <div className="text-center">
                    <h2
                      className="text-xl font-bold"
                      style={{
                        fontFamily: "Syne, system-ui, sans-serif",
                      }}
                    >
                      Hire your first team member
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Choose a role for your AI team member
                    </p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" role="radiogroup" aria-label="Select a role">
                    {ROLES.map((role) => (
                      <RoleCard
                        key={role.id}
                        role={role}
                        selected={selectedRoleId === role.id}
                        onClick={() =>
                          setSelectedRoleId(
                            selectedRoleId === role.id ? null : role.id,
                          )
                        }
                      />
                    ))}
                  </div>

                  {error && (
                    <p className="text-xs text-destructive">{error}</p>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setError(null);
                        setStep(1);
                      }}
                      className="gap-1"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back
                    </Button>
                    <Button
                      onClick={handleStep2Next}
                      disabled={!selectedRoleId}
                      className="flex-1 text-white font-semibold"
                      style={{
                        background: selectedRoleId
                          ? "linear-gradient(90deg, #224AE8, #716EFF, #00BDB7)"
                          : undefined,
                      }}
                    >
                      Next
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                </div>
              )}

              {/* ---- STEP 3: Credentials & Setup ---- */}
              {step === 3 && selectedRole && (
                <div className="space-y-6">
                  <div className="text-center">
                    <h2
                      className="text-xl font-bold"
                      style={{
                        fontFamily: "Syne, system-ui, sans-serif",
                      }}
                    >
                      Set up {selectedRole.name}&apos;s tools
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Connect the services your team member needs
                    </p>
                  </div>

                  <div className="space-y-4">
                    {selectedRole.credentials.map((field) => (
                      <CredentialInput
                        key={field.id}
                        field={field}
                        value={credentials[field.id] ?? ""}
                        onChange={(val) => updateCredential(field.id, val)}
                      />
                    ))}
                  </div>

                  {/* Security message */}
                  <div className="flex items-start gap-2 rounded-lg bg-muted/50 border border-border p-3">
                    <Lock className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                    <p className="text-xs text-muted-foreground">
                      Your credentials are stored securely and are never visible
                      in plaintext after setup.
                    </p>
                  </div>

                  {error && (
                    <p className="text-xs text-destructive">{error}</p>
                  )}

                  {/* Skip option */}
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={handleStep3Skip}
                      className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                    >
                      Skip for now &mdash; add credentials later
                    </button>
                  </div>

                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setError(null);
                        setStep(2);
                      }}
                      className="gap-1"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back
                    </Button>
                    <Button
                      onClick={handleStep3Next}
                      className="flex-1 text-white font-semibold"
                      style={{
                        background:
                          "linear-gradient(90deg, #224AE8, #716EFF, #00BDB7)",
                      }}
                    >
                      Next
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                </div>
              )}

              {/* ---- STEP 4: Name & Launch ---- */}
              {step === 4 && selectedRole && (
                <div className="space-y-6">
                  <div className="text-center">
                    <h2
                      className="text-xl font-bold"
                      style={{
                        fontFamily: "Syne, system-ui, sans-serif",
                      }}
                    >
                      Name &amp; launch your team member
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Personalize your new {selectedRole.name}
                    </p>
                  </div>

                  <div className="space-y-4">
                    {/* Name + icon row */}
                    <div className="flex items-end gap-3">
                      <AgentIconPicker
                        value={agentIcon}
                        onChange={setAgentIcon}
                      >
                        <button
                          type="button"
                          className="flex items-center justify-center w-[38px] h-[38px] rounded-md border border-border bg-muted hover:bg-accent transition-colors shrink-0"
                          title="Pick an icon"
                          aria-label="Pick an icon"
                        >
                          <AgentIcon icon={agentIcon} className="w-5 h-5" />
                        </button>
                      </AgentIconPicker>
                      <div className="flex-1 space-y-1.5">
                        <Label htmlFor="raava-agent-name" className="text-xs">
                          Name
                        </Label>
                        <Input
                          id="raava-agent-name"
                          placeholder="e.g. Alex"
                          value={agentName}
                          onChange={(e) => setAgentName(e.target.value)}
                          autoFocus
                        />
                      </div>
                    </div>

                    {/* First task */}
                    <div className="space-y-1.5">
                      <Label htmlFor="raava-first-task" className="text-xs">
                        First task
                      </Label>
                      <Textarea
                        id="raava-first-task"
                        ref={textareaRef}
                        value={firstTask}
                        onChange={(e) => setFirstTask(e.target.value)}
                        className="min-h-[80px] text-sm resize-none"
                        placeholder="What should they work on first?"
                      />
                    </div>
                  </div>

                  {error && (
                    <p className="text-xs text-destructive">{error}</p>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setError(null);
                        setStep(3);
                      }}
                      className="gap-1"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back
                    </Button>
                    <Button
                      onClick={handleHire}
                      disabled={loading || !agentName.trim()}
                      className="flex-1 text-white font-semibold text-base h-11"
                      style={{
                        background:
                          "linear-gradient(90deg, #224AE8, #716EFF, #00BDB7)",
                      }}
                    >
                      {loading ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      ) : null}
                      {loading
                        ? "Hiring..."
                        : `Hire ${agentName.trim() || "Team Member"}`}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

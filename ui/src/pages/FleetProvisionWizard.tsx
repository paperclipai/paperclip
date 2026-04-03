/**
 * Fleet Provision Wizard (RAA-294).
 *
 * A multi-step wizard for provisioning new Hermes agents via the FleetOS API.
 *
 * Steps:
 *   1. Select Template   -- choose a provisioning template
 *   2. Agent Config       -- name, role, model, resources, extra fields
 *   3. Review & Confirm   -- summary + start the provision job
 *   4. Progress & Result  -- poll job status, show steps, link to agent on success
 */

import { useEffect, useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import {
  fleetosApi,
  fleetosAuthApi,
  type FleetTemplateField,
  type ProvisionValidateRequest,
  type ProvisionValidateResponse,
  type ProvisionJob,
  type ProvisionStep,
} from "../api/fleetos";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  Circle,
  Loader2,
  Rocket,
  Server,
  XCircle,
  AlertTriangle,
  SkipForward,
} from "lucide-react";
import { Link } from "@/lib/router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3 | 4;

interface FormValues {
  agent_name: string;
  agent_role: string;
  model: string;
  memory: string;
  cpu: string;
  disk: string;
  secrets_mode: string;
  extra_fields: Record<string, string>;
}

const DEFAULT_FORM: FormValues = {
  agent_name: "",
  agent_role: "",
  model: "claude-sonnet-4-20250514",
  memory: "",
  cpu: "",
  disk: "",
  secrets_mode: "env",
  extra_fields: {},
};

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<Step, string> = {
  1: "Template",
  2: "Configure",
  3: "Review",
  4: "Provision",
};

function StepIndicator({ current }: { current: Step }) {
  const steps: Step[] = [1, 2, 3, 4];

  return (
    <div className="flex items-center gap-1">
      {steps.map((s) => {
        const isActive = s === current;
        const isComplete = s < current;
        return (
          <div key={s} className="flex items-center gap-1">
            {s > 1 && (
              <div
                className={cn(
                  "h-px w-8 sm:w-12",
                  isComplete ? "bg-foreground" : "bg-border",
                )}
              />
            )}
            <div
              className={cn(
                "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                isActive && "bg-foreground text-background",
                isComplete && "bg-foreground/10 text-foreground",
                !isActive && !isComplete && "bg-muted text-muted-foreground",
              )}
            >
              {isComplete ? (
                <Check className="h-3 w-3" />
              ) : (
                <span>{s}</span>
              )}
              <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Select Template
// ---------------------------------------------------------------------------

function StepSelectTemplate({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (name: string) => void;
}) {
  const {
    data: templates,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.fleet.provision.templates,
    queryFn: () => fleetosApi.listTemplates(),
  });

  // Auto-select if there is only one template
  useEffect(() => {
    if (templates && templates.length === 1 && !selected) {
      onSelect(templates[0].name);
    }
  }, [templates, selected, onSelect]);

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load templates"}
        </p>
      </div>
    );
  }

  if (!templates || templates.length === 0) {
    return (
      <div className="flex flex-col items-center py-12 text-center">
        <Server className="h-10 w-10 text-muted-foreground/50 mb-4" />
        <p className="text-sm text-muted-foreground">
          No provision templates available. Ensure FleetOS is configured with at
          least one template.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Select a template</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Choose the base template for your new agent container.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {templates.map((tpl) => (
          <button
            key={tpl.name}
            onClick={() => onSelect(tpl.name)}
            className={cn(
              "text-left rounded-lg border p-4 transition-all hover:border-foreground/30 hover:shadow-sm",
              selected === tpl.name
                ? "border-foreground bg-foreground/5 ring-1 ring-foreground/20"
                : "border-border bg-card",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{tpl.label || tpl.name}</span>
              {selected === tpl.name && (
                <CheckCircle2 className="h-4 w-4 text-foreground shrink-0" />
              )}
            </div>
            {tpl.description && (
              <p className="text-xs text-muted-foreground mt-1.5">
                {tpl.description}
              </p>
            )}
            <Badge variant="secondary" className="mt-2 text-[10px]">
              {tpl.name}
            </Badge>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Agent Configuration
// ---------------------------------------------------------------------------

function StepConfigure({
  templateName,
  formValues,
  onChange,
  validationResult,
  validationError,
  onValidate,
  isValidating,
}: {
  templateName: string;
  formValues: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
  validationResult: ProvisionValidateResponse | null;
  validationError: string | null;
  onValidate: () => void;
  isValidating: boolean;
}) {
  const { data: templateDetail, isError: templateError, error: templateFetchError } = useQuery({
    queryKey: queryKeys.fleet.provision.template(templateName),
    queryFn: () => fleetosApi.getTemplate(templateName),
    enabled: !!templateName,
  });

  // Apply template defaults when they arrive
  useEffect(() => {
    if (!templateDetail) return;
    const patch: Partial<FormValues> = {};
    if (templateDetail.default_memory && !formValues.memory) {
      patch.memory = templateDetail.default_memory;
    }
    if (templateDetail.default_cpu && !formValues.cpu) {
      patch.cpu = templateDetail.default_cpu;
    }
    if (templateDetail.default_disk && !formValues.disk) {
      patch.disk = templateDetail.default_disk;
    }
    // Pre-fill extra_fields defaults
    if (templateDetail.fields?.length) {
      const extras = { ...formValues.extra_fields };
      let changed = false;
      for (const f of templateDetail.fields) {
        if (f.default != null && !(f.name in extras)) {
          extras[f.name] = String(f.default);
          changed = true;
        }
      }
      if (changed) patch.extra_fields = extras;
    }
    if (Object.keys(patch).length > 0) onChange(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateDetail]);

  const setField = (key: keyof FormValues, value: string) => onChange({ [key]: value });
  const setExtraField = (name: string, value: string) =>
    onChange({ extra_fields: { ...formValues.extra_fields, [name]: value } });

  const dynamicFields: FleetTemplateField[] = templateDetail?.fields ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold">Agent Configuration</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Configure the agent identity, model, and resource limits.
        </p>
      </div>

      {templateError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">
            Failed to load template details: {templateFetchError instanceof Error ? templateFetchError.message : "Unknown error"}
          </p>
        </div>
      )}

      {/* Identity */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="agent_name">Agent Name *</Label>
          <Input
            id="agent_name"
            placeholder="e.g. hermes-ops-1"
            value={formValues.agent_name}
            onChange={(e) => setField("agent_name", e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent_role">Agent Role *</Label>
          <Input
            id="agent_role"
            placeholder="e.g. engineer, ops, qa"
            value={formValues.agent_role}
            onChange={(e) => setField("agent_role", e.target.value)}
          />
        </div>
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <Label htmlFor="model">Model</Label>
        <Input
          id="model"
          placeholder="claude-sonnet-4-20250514 or openrouter/auto"
          value={formValues.model}
          onChange={(e) => setField("model", e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          The LLM model the agent will use. Defaults to Claude Sonnet.
        </p>
      </div>

      {/* Resources */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Resources
        </h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="memory">Memory</Label>
            <Input
              id="memory"
              placeholder="4GB"
              value={formValues.memory}
              onChange={(e) => setField("memory", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cpu">CPU</Label>
            <Input
              id="cpu"
              placeholder="2"
              value={formValues.cpu}
              onChange={(e) => setField("cpu", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="disk">Disk</Label>
            <Input
              id="disk"
              placeholder="30GB"
              value={formValues.disk}
              onChange={(e) => setField("disk", e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Secrets mode */}
      <div className="space-y-1.5">
        <Label>Secrets Mode</Label>
        <Select
          value={formValues.secrets_mode}
          onValueChange={(v) => setField("secrets_mode", v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select secrets mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="env">env -- Environment variables</SelectItem>
            <SelectItem value="op">op -- 1Password integration</SelectItem>
            <SelectItem value="none">none -- No secrets</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Dynamic template fields */}
      {dynamicFields.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            Template Fields
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {dynamicFields.map((field) => (
              <DynamicField
                key={field.name}
                field={field}
                value={formValues.extra_fields[field.name] ?? ""}
                onChange={(v) => setExtraField(field.name, v)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Validation */}
      <div className="border-t border-border pt-4 space-y-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onValidate}
          disabled={isValidating || !formValues.agent_name.trim() || !formValues.agent_role.trim()}
        >
          {isValidating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Validating...
            </>
          ) : (
            <>
              <Check className="h-3.5 w-3.5 mr-1.5" />
              Validate Configuration
            </>
          )}
        </Button>

        {validationError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-destructive" />
              <span className="text-sm text-destructive">{validationError}</span>
            </div>
          </div>
        )}

        {validationResult && (
          <ValidationResultDisplay result={validationResult} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dynamic field renderer
// ---------------------------------------------------------------------------

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: FleetTemplateField;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `field-${field.name}`;

  if (field.type === "select" && field.options) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {field.label}{field.required ? " *" : ""}
        </Label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.description && (
          <p className="text-[11px] text-muted-foreground">{field.description}</p>
        )}
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {field.label}{field.required ? " *" : ""}
        </Label>
        <Select value={value || "false"} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
        {field.description && (
          <p className="text-[11px] text-muted-foreground">{field.description}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}{field.required ? " *" : ""}
      </Label>
      <Input
        id={id}
        type={field.type === "number" ? "number" : "text"}
        placeholder={field.default != null ? String(field.default) : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.description && (
        <p className="text-[11px] text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation result display
// ---------------------------------------------------------------------------

function ValidationResultDisplay({ result }: { result: ProvisionValidateResponse }) {
  if (result.valid) {
    return (
      <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium text-green-700 dark:text-green-400">
            Configuration is valid
          </span>
        </div>
        {result.container_name && (
          <p className="text-xs text-muted-foreground">
            Container name: <span className="font-mono font-medium">{result.container_name}</span>
          </p>
        )}
        {result.warnings && result.warnings.length > 0 && (
          <div className="space-y-1">
            {result.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}
        {result.checks && result.checks.length > 0 && (
          <div className="space-y-1 pt-1">
            {result.checks.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {c.status === "pass" ? (
                  <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                ) : c.status === "warn" ? (
                  <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                ) : (
                  <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                )}
                <span className="text-muted-foreground">{c.name}</span>
                {c.detail && <span className="text-muted-foreground/70">-- {c.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <XCircle className="h-4 w-4 text-destructive" />
        <span className="text-sm font-medium text-destructive">Validation failed</span>
      </div>
      {result.errors && result.errors.length > 0 && (
        <ul className="list-disc list-inside text-xs text-destructive space-y-0.5">
          {result.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Review & Confirm
// ---------------------------------------------------------------------------

function StepReview({
  templateName,
  formValues,
  validationResult,
}: {
  templateName: string;
  formValues: FormValues;
  validationResult: ProvisionValidateResponse | null;
}) {
  const rows: [string, string][] = [
    ["Template", templateName],
    ["Agent Name", formValues.agent_name],
    ["Agent Role", formValues.agent_role],
    ["Model", formValues.model || "(default)"],
    ["Memory", formValues.memory],
    ["CPU", formValues.cpu],
    ["Disk", formValues.disk],
    ["Secrets Mode", formValues.secrets_mode],
  ];

  if (validationResult?.container_name) {
    rows.push(["Container Name", validationResult.container_name]);
  }

  const extraEntries = Object.entries(formValues.extra_fields).filter(
    ([, v]) => v !== "",
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">Review Configuration</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Confirm the details below before starting provisioning.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="divide-y divide-border">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="flex items-center justify-between px-4 py-2.5"
            >
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="text-sm font-medium font-mono">{value}</span>
            </div>
          ))}
          {extraEntries.map(([key, value]) => (
            <div
              key={key}
              className="flex items-center justify-between px-4 py-2.5"
            >
              <span className="text-xs text-muted-foreground">{key}</span>
              <span className="text-sm font-medium font-mono">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {validationResult?.warnings && validationResult.warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              Warnings
            </span>
          </div>
          {validationResult.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-600 dark:text-amber-400 pl-6">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Progress & Result
// ---------------------------------------------------------------------------

function StepProgress({
  jobId,
  onRetry,
}: {
  jobId: string;
  onRetry: () => void;
}) {
  const navigate = useNavigate();

  const { data: job, error } = useQuery({
    queryKey: queryKeys.fleet.provision.job(jobId),
    queryFn: () => fleetosApi.getProvisionJob(jobId),
    refetchInterval: (query) => {
      const status = (query.state.data as ProvisionJob | undefined)?.status;
      if (status === "complete" || status === "failed" || status === "cancelled" || status === "timeout") {
        return false;
      }
      return 3000;
    },
    refetchIntervalInBackground: true,
  });

  const isTerminal =
    job?.status === "complete" ||
    job?.status === "failed" ||
    job?.status === "cancelled" ||
    job?.status === "timeout";

  if (error && !job) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 space-y-3">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to fetch job status"}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex flex-col items-center py-12 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Starting provision job...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status header */}
      <div className="flex items-center gap-3">
        {job.status === "complete" ? (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10">
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          </div>
        ) : job.status === "failed" || job.status === "timeout" ? (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
            <XCircle className="h-5 w-5 text-destructive" />
          </div>
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/5">
            <Loader2 className="h-5 w-5 animate-spin text-foreground" />
          </div>
        )}
        <div>
          <h2 className="text-sm font-semibold">
            {job.status === "complete"
              ? "Provisioning Complete"
              : job.status === "failed"
                ? "Provisioning Failed"
                : job.status === "timeout"
                  ? "Provisioning Timed Out"
                  : job.status === "cancelled"
                    ? "Provisioning Cancelled"
                    : "Provisioning in Progress..."}
          </h2>
          <p className="text-xs text-muted-foreground">
            Job: <span className="font-mono">{job.id}</span>
          </p>
        </div>
      </div>

      {/* Steps */}
      {job.steps && job.steps.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <div className="divide-y divide-border">
            {job.steps.map((step, i) => (
              <ProvisionStepRow key={i} step={step} />
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {job.error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{job.error}</p>
        </div>
      )}

      {/* Actions */}
      {isTerminal && (
        <div className="flex items-center gap-3">
          {job.status === "complete" && job.container_name && (
            <Button
              size="sm"
              onClick={() => navigate(`/fleet/${encodeURIComponent(job.container_name!)}`)}
            >
              <Server className="h-3.5 w-3.5 mr-1.5" />
              View Agent
            </Button>
          )}
          {job.status === "complete" && (
            <Button variant="outline" size="sm" onClick={() => navigate("/fleet")}>
              Back to Fleet
            </Button>
          )}
          {(job.status === "failed" || job.status === "timeout" || job.status === "cancelled") && (
            <>
              <Button size="sm" onClick={onRetry}>
                <Rocket className="h-3.5 w-3.5 mr-1.5" />
                Retry
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate("/fleet")}>
                Back to Fleet
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ProvisionStepRow({ step }: { step: ProvisionStep }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="shrink-0">
        {step.status === "done" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
        {step.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-foreground" />}
        {step.status === "failed" && <XCircle className="h-4 w-4 text-destructive" />}
        {step.status === "pending" && <Circle className="h-4 w-4 text-muted-foreground/40" />}
        {step.status === "skipped" && <SkipForward className="h-4 w-4 text-muted-foreground/40" />}
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{step.name}</span>
        {step.detail && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{step.detail}</p>
        )}
      </div>
      <Badge
        variant={
          step.status === "done"
            ? "default"
            : step.status === "running"
              ? "secondary"
              : step.status === "failed"
                ? "destructive"
                : "outline"
        }
        className="text-[10px] shrink-0"
      >
        {step.status}
      </Badge>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Wizard
// ---------------------------------------------------------------------------

export function FleetProvisionWizard() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [formValues, setFormValues] = useState<FormValues>(DEFAULT_FORM);
  const [validationResult, setValidationResult] = useState<ProvisionValidateResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  // Fetch current tenant for tenant_id in provision requests
  const { data: meData } = useQuery({
    queryKey: ["fleetos", "me"],
    queryFn: () => fleetosAuthApi.me(),
    staleTime: 60_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Fleet", href: "/fleet" },
      { label: "Provision New Agent" },
    ]);
  }, [setBreadcrumbs]);

  const handleFormChange = useCallback(
    (patch: Partial<FormValues>) => {
      setFormValues((prev) => ({ ...prev, ...patch }));
      // Always clear validation when any field changes (including extra_fields)
      setValidationResult(null);
    },
    [],
  );

  const handleSelectTemplate = useCallback((name: string) => {
    setSelectedTemplate(name);
    // Reset template-scoped state when switching templates
    setFormValues((prev) => ({ ...prev, memory: "", cpu: "", disk: "", extra_fields: {} }));
    setValidationResult(null);
  }, []);

  // Build the request body from current form state
  const buildRequestBody = useCallback((): ProvisionValidateRequest => {
    const body: ProvisionValidateRequest = {
      template: selectedTemplate,
      tenant_id: meData?.tenantId ?? "",
      agent_name: formValues.agent_name.trim(),
      agent_role: formValues.agent_role.trim(),
    };
    if (formValues.model.trim()) body.model = formValues.model.trim();
    if (formValues.memory.trim()) body.memory = formValues.memory.trim();
    if (formValues.cpu.trim()) body.cpu = formValues.cpu.trim();
    if (formValues.disk.trim()) body.disk = formValues.disk.trim();
    if (formValues.secrets_mode) body.secrets_mode = formValues.secrets_mode;
    const extras = Object.fromEntries(
      Object.entries(formValues.extra_fields).filter(([, v]) => v !== ""),
    );
    if (Object.keys(extras).length > 0) body.extra_fields = extras;
    return body;
  }, [selectedTemplate, formValues, meData?.tenantId]);

  // Validate mutation
  const [validationError, setValidationError] = useState<string | null>(null);
  const validateMutation = useMutation({
    mutationFn: (body: ProvisionValidateRequest) => fleetosApi.validateProvision(body),
    onSuccess: (result) => {
      setValidationResult(result);
      setValidationError(null);
    },
    onError: (err) => {
      setValidationError(err instanceof Error ? err.message : "Validation request failed");
      setValidationResult(null);
    },
  });

  const handleValidate = useCallback(() => {
    validateMutation.mutate(buildRequestBody());
  }, [validateMutation, buildRequestBody]);

  // Provision mutation
  const provisionMutation = useMutation({
    mutationFn: () => fleetosApi.startProvision(buildRequestBody()),
    onSuccess: (result) => {
      setJobId(result.id ?? result.job_id ?? "");
      setStep(4);
    },
  });

  const handleProvision = useCallback(() => {
    provisionMutation.mutate();
  }, [provisionMutation]);

  const handleRetry = useCallback(() => {
    setJobId(null);
    setStep(3);
    provisionMutation.reset();
  }, [provisionMutation]);

  // Step navigation guards
  const canAdvance = useMemo(() => {
    switch (step) {
      case 1:
        return !!selectedTemplate;
      case 2:
        return (
          !!formValues.agent_name.trim() &&
          !!formValues.agent_role.trim() &&
          validationResult?.valid === true
        );
      case 3:
        return true; // "Provision" button handles it
      default:
        return false;
    }
  }, [step, selectedTemplate, formValues, validationResult]);

  const handleNext = useCallback(() => {
    if (step === 3) {
      handleProvision();
      return;
    }
    if (step < 4 && canAdvance) {
      setStep((s) => (s + 1) as Step);
    }
  }, [step, canAdvance, handleProvision]);

  const handleBack = useCallback(() => {
    if (step > 1 && step < 4) {
      setStep((s) => (s - 1) as Step);
    }
  }, [step]);

  return (
    <div className="space-y-6">
      {/* Back to fleet */}
      <Link
        to="/fleet"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground no-underline"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to Fleet
      </Link>

      {/* Header + Step indicator */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold">Provision New Agent</h1>
          <p className="text-sm text-muted-foreground">
            Set up and deploy a new Hermes agent container.
          </p>
        </div>
        <StepIndicator current={step} />
      </div>

      {/* Step content */}
      <div className="rounded-lg border border-border bg-card p-6">
        {step === 1 && (
          <StepSelectTemplate
            selected={selectedTemplate}
            onSelect={handleSelectTemplate}
          />
        )}
        {step === 2 && (
          <StepConfigure
            templateName={selectedTemplate}
            formValues={formValues}
            onChange={handleFormChange}
            validationResult={validationResult}
            validationError={validationError}
            onValidate={handleValidate}
            isValidating={validateMutation.isPending}
          />
        )}
        {step === 3 && (
          <StepReview
            templateName={selectedTemplate}
            formValues={formValues}
            validationResult={validationResult}
          />
        )}
        {step === 4 && jobId && (
          <StepProgress jobId={jobId} onRetry={handleRetry} />
        )}
      </div>

      {/* Navigation bar (steps 1-3 only) */}
      {step < 4 && (
        <div className="flex items-center justify-between">
          <div>
            {step > 1 && (
              <Button variant="outline" size="sm" onClick={handleBack}>
                <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {provisionMutation.error && (
              <p className="text-xs text-destructive mr-2">
                {provisionMutation.error instanceof Error
                  ? provisionMutation.error.message
                  : "Provision failed to start"}
              </p>
            )}
            {step === 3 ? (
              <Button
                size="sm"
                onClick={handleProvision}
                disabled={provisionMutation.isPending}
              >
                {provisionMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Rocket className="h-3.5 w-3.5 mr-1.5" />
                    Provision Agent
                  </>
                )}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleNext}
                disabled={!canAdvance}
              >
                Next
                <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

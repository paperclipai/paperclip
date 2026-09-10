import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, Save, ShieldCheck } from "lucide-react";
import {
  DELIVERY_AUTO_DEPLOY_DISPOSITIONS,
  DELIVERY_MERGE_METHODS,
  DELIVERY_MERGE_QUEUE_MODES,
  type DeliveryAutoDeployDisposition,
  type DeliveryMergeMethod,
  type DeliveryMergeQueueMode,
  type DeliveryPolicy,
  type DeliveryPolicyWriteInput,
} from "@paperclipai/shared";
import { deliveryApi } from "../../api/delivery";
import { toolsApi } from "../../api/tools";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";
import {
  DELIVERY_AUTO_DEPLOY_DISPOSITION_LABELS,
  DELIVERY_MERGE_METHOD_LABELS,
  DELIVERY_MERGE_QUEUE_MODE_LABELS,
  authorizationLabel,
  authorizationStateMessage,
} from "../../lib/delivery-display";
import { useOptionalToastActions } from "../../context/ToastContext";
import { InlineBanner } from "../InlineBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const NO_CONNECTION = "__none__";

/**
 * Editor form model — normalized control state, not a wire type. The two enums
 * are nullable so a brand-new policy starts unselected instead of inventing a
 * merge method or queue mode the server never chose.
 */
type PolicyFormState = {
  enabled: boolean;
  paused: boolean;
  targetBranch: string;
  mergeMethod: DeliveryMergeMethod | null;
  mergeQueueMode: DeliveryMergeQueueMode | null;
  requiredChecks: string[];
  requireGreptile: boolean;
  requireIndependentApproval: boolean;
  githubConnectionId: string | null;
  greptileConnectionId: string | null;
  autoDeployDisposition: DeliveryAutoDeployDisposition;
  repositoryUrl: string;
};

export interface ProjectDeliveryPolicyCardProps {
  companyId: string;
  projectId: string;
}

function policyToForm(policy: DeliveryPolicy | null): PolicyFormState {
  return {
    enabled: policy?.enabled ?? false,
    paused: policy?.paused ?? false,
    targetBranch: policy?.targetBranch ?? "",
    mergeMethod: policy?.mergeMethod ?? null,
    mergeQueueMode: policy?.mergeQueueMode ?? null,
    requiredChecks: policy?.requiredChecks ? [...policy.requiredChecks] : [],
    requireGreptile: policy?.requireGreptile ?? false,
    // Contract default is true: an operator must opt out explicitly, and the UI
    // never silently disables it.
    requireIndependentApproval: policy?.requireIndependentApproval ?? true,
    githubConnectionId: policy?.githubConnectionId ?? null,
    greptileConnectionId: policy?.greptileConnectionId ?? null,
    autoDeployDisposition: policy?.autoDeployDisposition ?? "none",
    repositoryUrl: "",
  };
}

function policyValidationError(form: PolicyFormState): string | null {
  if (form.targetBranch.trim().length === 0) return "A target branch is required.";
  if (!form.mergeMethod) return "Select a merge method.";
  if (!form.mergeQueueMode) return "Select a merge queue mode.";
  if (form.enabled && !form.githubConnectionId) {
    return "Select a GitHub connection before enabling auto merge.";
  }
  if (form.requireGreptile && !form.greptileConnectionId) {
    return "Select a Greptile connection before requiring review.";
  }
  return null;
}

/**
 * Create sends every chosen value; update sends changed fields only. The write
 * schema is partial and strict, so an untouched field must never be resent —
 * that is what keeps every stored policy value (including the server-owned
 * authorization record) intact on round-trip.
 */
function policyWriteDiff(form: PolicyFormState, policy: DeliveryPolicy | null): DeliveryPolicyWriteInput {
  const repositoryUrl = form.repositoryUrl.trim();
  if (!policy) {
    return {
      enabled: form.enabled,
      paused: form.paused,
      targetBranch: form.targetBranch.trim(),
      ...(form.mergeMethod ? { mergeMethod: form.mergeMethod } : {}),
      ...(form.mergeQueueMode ? { mergeQueueMode: form.mergeQueueMode } : {}),
      requiredChecks: form.requiredChecks,
      requireGreptile: form.requireGreptile,
      requireIndependentApproval: form.requireIndependentApproval,
      githubConnectionId: form.githubConnectionId,
      greptileConnectionId: form.greptileConnectionId,
      autoDeployDisposition: form.autoDeployDisposition,
      ...(repositoryUrl ? { repositoryUrl } : {}),
    };
  }
  const body: DeliveryPolicyWriteInput = {};
  if (form.enabled !== policy.enabled) body.enabled = form.enabled;
  if (form.paused !== policy.paused) body.paused = form.paused;
  if (form.targetBranch.trim() !== policy.targetBranch) body.targetBranch = form.targetBranch.trim();
  if (form.mergeMethod && form.mergeMethod !== policy.mergeMethod) body.mergeMethod = form.mergeMethod;
  if (form.mergeQueueMode && form.mergeQueueMode !== policy.mergeQueueMode) {
    body.mergeQueueMode = form.mergeQueueMode;
  }
  if (form.requiredChecks.join("\n") !== policy.requiredChecks.join("\n")) {
    body.requiredChecks = form.requiredChecks;
  }
  if (form.requireGreptile !== policy.requireGreptile) body.requireGreptile = form.requireGreptile;
  if (form.requireIndependentApproval !== policy.requireIndependentApproval) {
    body.requireIndependentApproval = form.requireIndependentApproval;
  }
  if (form.githubConnectionId !== policy.githubConnectionId) body.githubConnectionId = form.githubConnectionId;
  if (form.greptileConnectionId !== policy.greptileConnectionId) {
    body.greptileConnectionId = form.greptileConnectionId;
  }
  if (form.autoDeployDisposition !== policy.autoDeployDisposition) {
    body.autoDeployDisposition = form.autoDeployDisposition;
  }
  if (repositoryUrl) body.repositoryUrl = repositoryUrl;
  return body;
}

/**
 * Project delivery policy — the governed, operator-only settings that authorize
 * automated merge for one project against its repository. The standing
 * authorization record is server-owned: this form reads it and never invents
 * it. Connection ids only; no credential material passes through this surface.
 */
export function ProjectDeliveryPolicyCard({ companyId, projectId }: ProjectDeliveryPolicyCardProps) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const policyQuery = useQuery({
    queryKey: queryKeys.delivery.policy(projectId),
    queryFn: () => deliveryApi.getProjectPolicy(projectId, companyId),
    enabled: Boolean(projectId && companyId),
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
    enabled: Boolean(companyId),
  });
  const [form, setForm] = useState<PolicyFormState | null>(null);
  const [dirty, setDirty] = useState(false);

  const policy = policyQuery.data ?? null;
  useEffect(() => {
    if (!policyQuery.isSuccess) return;
    // A background refetch must not clobber an in-progress edit.
    if (dirty) return;
    setForm(policyToForm(policy));
  }, [dirty, policy, policyQuery.isSuccess]);

  const connections = useMemo(
    () => (connectionsQuery.data?.connections ?? []).filter((connection) => connection.enabled !== false),
    [connectionsQuery.data],
  );

  const saveMutation = useMutation({
    mutationFn: (body: DeliveryPolicyWriteInput) => deliveryApi.putProjectPolicy(projectId, body, companyId),
    onSuccess: () => {
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.delivery.policy(projectId) });
      void queryClient.invalidateQueries({ queryKey: ["delivery"] });
      toast?.pushToast({ title: "Delivery policy saved", tone: "success" });
    },
    onError: (error) => {
      toast?.pushToast({
        title: "Delivery policy not saved",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const update = (patch: Partial<PolicyFormState>) => {
    setForm((current) => ({ ...(current ?? policyToForm(policy)), ...patch }));
    setDirty(true);
  };

  if (policyQuery.isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (policyQuery.error) {
    return (
      <InlineBanner
        tone="danger"
        title="Delivery policy unavailable"
        actions={
          <Button variant="outline" size="sm" onClick={() => void policyQuery.refetch()}>
            Retry
          </Button>
        }
      >
        {policyQuery.error instanceof Error ? policyQuery.error.message : "The delivery service did not respond."}
      </InlineBanner>
    );
  }

  const effectiveForm = form ?? policyToForm(policy);
  const validationError = policyValidationError(effectiveForm);
  const pendingChanges = policyWriteDiff(effectiveForm, policy);
  const hasPendingChanges = Object.keys(pendingChanges).length > 0;
  const authorization = policy?.authorization ?? null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <GitPullRequest className="h-4 w-4" aria-hidden />
            Delivery policy
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Operator-only authorization for automated merge on this project's repository. Checks, review
            requirements, and the merge method are enforced by the delivery service — the board only records
            the decision.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={saveMutation.isPending}
              onClick={() => {
                setForm(policyToForm(policy));
                setDirty(false);
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={!hasPendingChanges || saveMutation.isPending || validationError !== null}
            onClick={() => saveMutation.mutate(pendingChanges)}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {saveMutation.isPending ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </div>

      {policy === null && !dirty ? (
        <InlineBanner tone="info" compact title="No policy recorded">
          This project has no delivery policy, so automated merge is off. Set the target, checks, and merge
          method below and save to create one.
        </InlineBanner>
      ) : null}

      {policy ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-md border border-border/70 p-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-0.5">
            <dt className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              Repository
            </dt>
            <dd className="font-mono text-xs">
              {policy.repository ?? "—"}
              {policy.repositoryHost ? (
                <span className="text-muted-foreground"> · {policy.repositoryHost}</span>
              ) : null}
            </dd>
          </div>
          <div className="min-w-0 space-y-0.5">
            <dt className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              GitHub repository id
            </dt>
            <dd className="font-mono text-xs">{policy.githubRepositoryId ?? policy.repositoryId ?? "—"}</dd>
          </div>
        </dl>
      ) : null}

      {validationError ? (
        <InlineBanner tone="warning" compact title="Policy incomplete">
          {validationError}
        </InlineBanner>
      ) : null}

      {saveMutation.error ? (
        <InlineBanner tone="danger" compact title="Policy not saved">
          {saveMutation.error instanceof Error ? saveMutation.error.message : "The delivery service rejected the update."}
          {/authorization/i.test(
            saveMutation.error instanceof Error ? saveMutation.error.message : "",
          ) ? (
            <p className="mt-1">
              Standing merge authority is server-owned: enabling automated merge needs a recorded operator
              authorization, and this form never invents one. Merges stay manual until the delivery service
              records it.
            </p>
          ) : null}
        </InlineBanner>
      ) : null}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="delivery-policy-enabled">Automated merge</Label>
            <p className="text-xs text-muted-foreground">
              Standing authority for this project's repository. Off means every merge stays manual.
            </p>
          </div>
          <ToggleSwitch
            id="delivery-policy-enabled"
            checked={effectiveForm.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="delivery-policy-paused">Paused</Label>
            <p className="text-xs text-muted-foreground">
              Holds queue admission without discarding the policy or the recorded authorization.
            </p>
          </div>
          <ToggleSwitch
            id="delivery-policy-paused"
            checked={effectiveForm.paused}
            onCheckedChange={(checked) => update({ paused: checked })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delivery-policy-target">Target branch</Label>
            <Input
              id="delivery-policy-target"
              value={effectiveForm.targetBranch}
              onChange={(event) => update({ targetBranch: event.currentTarget.value })}
              placeholder="main"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delivery-policy-method">Merge method</Label>
            <Select
              value={effectiveForm.mergeMethod ?? undefined}
              onValueChange={(value) => update({ mergeMethod: value as DeliveryMergeMethod })}
            >
              <SelectTrigger id="delivery-policy-method">
                <SelectValue placeholder="Select a merge method" />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_MERGE_METHODS.map((method) => (
                  <SelectItem key={method} value={method}>
                    {DELIVERY_MERGE_METHOD_LABELS[method]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delivery-policy-queue-mode">Merge queue mode</Label>
            <Select
              value={effectiveForm.mergeQueueMode ?? undefined}
              onValueChange={(value) => update({ mergeQueueMode: value as DeliveryMergeQueueMode })}
            >
              <SelectTrigger id="delivery-policy-queue-mode">
                <SelectValue placeholder="Select a queue mode" />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_MERGE_QUEUE_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {DELIVERY_MERGE_QUEUE_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delivery-policy-deploy">Auto-deploy disposition</Label>
            <Select
              value={effectiveForm.autoDeployDisposition}
              onValueChange={(value) => update({ autoDeployDisposition: value as DeliveryAutoDeployDisposition })}
            >
              <SelectTrigger id="delivery-policy-deploy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_AUTO_DEPLOY_DISPOSITIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {DELIVERY_AUTO_DEPLOY_DISPOSITION_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="delivery-policy-checks">Required checks</Label>
          <Textarea
            id="delivery-policy-checks"
            value={effectiveForm.requiredChecks.join("\n")}
            onChange={(event) =>
              update({
                requiredChecks: event.currentTarget.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
              })
            }
            placeholder={"One check name per line, e.g.\nci/build\nci/test"}
            className="min-h-(--sz-80px) font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Every listed check must pass on the current head before the delivery service merges.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="delivery-policy-greptile">Require Greptile review</Label>
            <p className="text-xs text-muted-foreground">
              Blocks readiness until the scoped review on the current head has no blocking findings.
            </p>
          </div>
          <ToggleSwitch
            id="delivery-policy-greptile"
            checked={effectiveForm.requireGreptile}
            onCheckedChange={(checked) => update({ requireGreptile: checked })}
          />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="delivery-policy-independent-approval">Require independent approval</Label>
            <p className="text-xs text-muted-foreground">
              Blocks readiness until someone other than the author approves the current head. Connection
              identity never satisfies this requirement.
            </p>
          </div>
          <ToggleSwitch
            id="delivery-policy-independent-approval"
            checked={effectiveForm.requireIndependentApproval}
            onCheckedChange={(checked) => update({ requireIndependentApproval: checked })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delivery-policy-github">GitHub connection</Label>
            <Select
              value={effectiveForm.githubConnectionId ?? NO_CONNECTION}
              onValueChange={(value) => update({ githubConnectionId: value === NO_CONNECTION ? null : value })}
            >
              <SelectTrigger id="delivery-policy-github">
                <SelectValue placeholder="Select a connection" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CONNECTION}>None</SelectItem>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {connectionsQuery.error ? (
              <p role="alert" className="text-xs text-destructive">
                Connections unavailable:{" "}
                {connectionsQuery.error instanceof Error ? connectionsQuery.error.message : "unknown error"}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delivery-policy-greptile-connection">Greptile connection</Label>
            <Select
              value={effectiveForm.greptileConnectionId ?? NO_CONNECTION}
              onValueChange={(value) => update({ greptileConnectionId: value === NO_CONNECTION ? null : value })}
            >
              <SelectTrigger id="delivery-policy-greptile-connection">
                <SelectValue placeholder="Select a connection" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CONNECTION}>None</SelectItem>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="delivery-policy-repository-url">Repository URL</Label>
          <Input
            id="delivery-policy-repository-url"
            value={effectiveForm.repositoryUrl}
            onChange={(event) => update({ repositoryUrl: event.currentTarget.value })}
            placeholder="https://github.com/owner/name"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Set or replace the repository binding. Leave blank to keep the current binding; the canonical
            identity stays server-owned.
          </p>
        </div>
      </div>

      <Separator />

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div className="space-y-0.5">
          <p>
            {authorization
              ? `${authorizationLabel(authorization)}${policy?.version ? ` · policy version ${policy.version}` : ""}${
                  policy?.updatedAt ? ` · updated ${formatDateTime(policy.updatedAt)}` : ""
                }.`
              : authorizationStateMessage(policy)}
          </p>
          {authorization ? (
            <p className="break-words" title={authorization.statement}>
              {authorization.statement}
            </p>
          ) : policy?.authorizationState === "invalidated" && policy.authorizationInvalidatedAt ? (
            <p className="break-words">
              Voided {formatDateTime(policy.authorizationInvalidatedAt)} by the scope change above; the previous
              approval does not carry over.
            </p>
          ) : null}
          <p>
            Connection ids only — credentials stay in the connection service. The authorization record is
            server-owned; this form reads it and never invents it.
          </p>
        </div>
      </div>
    </section>
  );
}

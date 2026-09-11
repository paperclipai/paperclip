import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ATTEMPT_ROLES,
  PROVIDER_FAMILIES,
  TASK_CLASSES,
  type AttemptRole,
  type ExecutionProfile,
  type ProviderFamily,
  type RouteAdvisorMode,
  type RouteReviewRequirement,
  type RouteReviewerFallbackPolicy,
  type RouteRule,
  type RouteRuleDefaultsResult,
  type TaskClass,
  type UpsertRouteRuleInput,
} from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { agentsApi } from "../api/agents";
import { routingApi } from "../api/routing";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";

/**
 * Maps routing API failures onto the explicit operator strings the routing
 * contract requires: 409 concurrency conflicts get a reload hint and 422
 * invariant violations surface their `details.code` verbatim.
 */
export function describeRoutingError(error: unknown): string {
  if (error instanceof ApiError) {
    const details = (error.body as { details?: { code?: string; currentRevision?: number } } | null)?.details;
    if (error.status === 409 && details?.code === "version_conflict") {
      return "Version conflict: this record changed since you loaded it. Reload and retry.";
    }
    if (error.status === 409 && details?.code === "route_revision_conflict") {
      return `Route changed to revision ${details.currentRevision}; reload before retrying.`;
    }
    if (error.status === 422 && details?.code) return details.code;
    return error.message;
  }
  return error instanceof Error ? error.message : "Request failed";
}

const selectClass =
  "rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none";
const inputClass =
  "rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none";
const numberClass = `${inputClass} w-20`;

interface ProfileFormState {
  name: string;
  providerFamily: ProviderFamily;
  agentId: string;
  model: string;
  effort: string;
  roleCapabilities: AttemptRole[];
  maxConcurrentAttempts: number;
}

const EMPTY_PROFILE_FORM: ProfileFormState = {
  name: "",
  providerFamily: "anthropic",
  agentId: "",
  model: "",
  effort: "",
  roleCapabilities: ["worker"],
  maxConcurrentAttempts: 1,
};

function ProfileForm({
  value,
  onChange,
  agents,
  idPrefix,
}: {
  value: ProfileFormState;
  onChange: (next: ProfileFormState) => void;
  agents: { id: string; name: string }[];
  idPrefix: string;
}) {
  const toggleRole = (role: AttemptRole) => {
    const has = value.roleCapabilities.includes(role);
    onChange({
      ...value,
      roleCapabilities: has
        ? value.roleCapabilities.filter((r) => r !== role)
        : [...value.roleCapabilities, role],
    });
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Name
        <input
          aria-label={`${idPrefix} profile name`}
          className={inputClass}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Provider family
        <select
          aria-label={`${idPrefix} provider family`}
          className={selectClass}
          value={value.providerFamily}
          onChange={(e) => onChange({ ...value, providerFamily: e.target.value as ProviderFamily })}
        >
          {PROVIDER_FAMILIES.map((family) => (
            <option key={family} value={family}>{family}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Agent
        <select
          aria-label={`${idPrefix} agent`}
          className={selectClass}
          value={value.agentId}
          onChange={(e) => onChange({ ...value, agentId: e.target.value })}
        >
          <option value="">Select agent…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Model
        <input
          aria-label={`${idPrefix} model`}
          className={inputClass}
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Effort
        <input
          aria-label={`${idPrefix} effort`}
          className={`${inputClass} w-20`}
          value={value.effort}
          onChange={(e) => onChange({ ...value, effort: e.target.value })}
        />
      </label>
      <fieldset className="flex flex-col gap-1 text-xs text-muted-foreground">
        <legend>Roles</legend>
        <div className="flex items-center gap-2">
          {ATTEMPT_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={value.roleCapabilities.includes(role)}
                onChange={() => toggleRole(role)}
              />
              {role}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Max concurrent
        <input
          aria-label={`${idPrefix} max concurrent attempts`}
          type="number"
          min={1}
          max={64}
          className={numberClass}
          value={value.maxConcurrentAttempts}
          onChange={(e) => onChange({ ...value, maxConcurrentAttempts: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}

interface RuleDraft {
  workerProfileId: string;
  advisorProfileId: string;
  advisorMode: RouteAdvisorMode;
  reviewerProfileId: string;
  reviewerFallbackProfileId: string;
  reviewRequirement: RouteReviewRequirement;
  reviewerFallbackPolicy: RouteReviewerFallbackPolicy;
  rescueProfileId: string;
  maxAttempts: number;
  maxWallClockMinutes: number;
  maxCostCents: string;
}

const EMPTY_RULE_DRAFT: RuleDraft = {
  workerProfileId: "",
  advisorProfileId: "",
  advisorMode: "none",
  reviewerProfileId: "",
  reviewerFallbackProfileId: "",
  reviewRequirement: "always",
  reviewerFallbackPolicy: "fallback",
  rescueProfileId: "",
  maxAttempts: 3,
  maxWallClockMinutes: 120,
  maxCostCents: "",
};

function draftFromRule(rule: RouteRule): RuleDraft {
  return {
    workerProfileId: rule.workerProfileId ?? "",
    advisorProfileId: rule.advisorProfileId ?? "",
    advisorMode: rule.advisorMode,
    reviewerProfileId: rule.reviewerProfileId ?? "",
    reviewerFallbackProfileId: rule.reviewerFallbackProfileId ?? "",
    reviewRequirement: rule.reviewRequirement,
    reviewerFallbackPolicy: rule.reviewerFallbackPolicy,
    rescueProfileId: rule.rescueProfileId ?? "",
    maxAttempts: rule.maxAttempts,
    maxWallClockMinutes: rule.maxWallClockMinutes,
    maxCostCents: rule.maxCostCents === null ? "" : String(rule.maxCostCents),
  };
}

function draftToInput(taskClass: TaskClass, draft: RuleDraft, existing: RouteRule | undefined): UpsertRouteRuleInput {
  return {
    taskClass,
    expectedVersion: existing?.version ?? null,
    workerProfileId: draft.workerProfileId || null,
    advisorProfileId: draft.advisorProfileId || null,
    advisorMode: draft.advisorMode,
    reviewerProfileId: draft.reviewerProfileId || null,
    reviewerFallbackProfileId: draft.reviewerFallbackProfileId || null,
    reviewRequirement: draft.reviewRequirement,
    reviewerFallbackPolicy: draft.reviewerFallbackPolicy,
    rescueProfileId: draft.rescueProfileId || null,
    maxAttempts: draft.maxAttempts,
    maxWallClockMinutes: draft.maxWallClockMinutes,
    maxCostCents: draft.maxCostCents === "" ? null : Number(draft.maxCostCents),
  };
}

function ProfileSelect({
  label,
  value,
  onChange,
  profiles,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  profiles: ExecutionProfile[];
}) {
  return (
    <select
      aria-label={label}
      className={selectClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">None</option>
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id}>{profile.name}</option>
      ))}
    </select>
  );
}

export function CompanyRouting() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Routing" },
    ]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId;

  const profilesQuery = useQuery({
    queryKey: companyId ? queryKeys.routing.profiles(companyId) : ["routing", "__disabled__", "profiles"],
    queryFn: () => routingApi.listProfiles(companyId!),
    enabled: !!companyId,
  });
  const rulesQuery = useQuery({
    queryKey: companyId ? queryKeys.routing.rules(companyId) : ["routing", "__disabled__", "rules"],
    queryFn: () => routingApi.listRules(companyId!),
    enabled: !!companyId,
  });
  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "__disabled__"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const profiles = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);
  const rules = useMemo(() => rulesQuery.data ?? [], [rulesQuery.data]);
  const agents = useMemo(
    () => (agentsQuery.data ?? []).map((agent) => ({ id: agent.id, name: agent.name })),
    [agentsQuery.data],
  );
  const agentName = (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId;

  const invalidateProfiles = () =>
    companyId ? queryClient.invalidateQueries({ queryKey: queryKeys.routing.profiles(companyId) }) : Promise.resolve();
  const invalidateRules = () =>
    companyId ? queryClient.invalidateQueries({ queryKey: queryKeys.routing.rules(companyId) }) : Promise.resolve();

  // --- profiles -------------------------------------------------------------

  const [createForm, setCreateForm] = useState<ProfileFormState>(EMPTY_PROFILE_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ProfileFormState>(EMPTY_PROFILE_FORM);
  const [profileError, setProfileError] = useState<string | null>(null);

  const createProfileMutation = useMutation({
    mutationFn: () =>
      routingApi.createProfile(companyId!, {
        name: createForm.name,
        providerFamily: createForm.providerFamily,
        agentId: createForm.agentId,
        model: createForm.model,
        effort: createForm.effort,
        roleCapabilities: createForm.roleCapabilities,
        maxConcurrentAttempts: createForm.maxConcurrentAttempts,
      }),
    onSuccess: async () => {
      setCreateError(null);
      setCreateForm(EMPTY_PROFILE_FORM);
      await invalidateProfiles();
    },
    onError: (error) => setCreateError(describeRoutingError(error)),
  });

  const updateProfileMutation = useMutation({
    mutationFn: ({ profile, patch }: { profile: ExecutionProfile; patch: Record<string, unknown> }) =>
      routingApi.updateProfile(profile.id, {
        expectedVersion: profile.version,
        ...patch,
      // The endpoint's patch shape is a strict zod object; the cast keeps the
      // heterogeneous inline-toggle/edit call sites on one mutation.
      } as Parameters<typeof routingApi.updateProfile>[1]),
    onSuccess: async () => {
      setProfileError(null);
      setEditingProfileId(null);
      await invalidateProfiles();
    },
    onError: (error) => setProfileError(describeRoutingError(error)),
  });

  // --- rules ----------------------------------------------------------------

  const [ruleDrafts, setRuleDrafts] = useState<Partial<Record<TaskClass, RuleDraft>>>({});
  const [ruleErrors, setRuleErrors] = useState<Partial<Record<TaskClass, string>>>({});

  useEffect(() => {
    setRuleDrafts((previous) => {
      const next = { ...previous };
      for (const rule of rules) {
        if (!next[rule.taskClass]) next[rule.taskClass] = draftFromRule(rule);
      }
      return next;
    });
  }, [rules]);

  const upsertRuleMutation = useMutation({
    mutationFn: (input: UpsertRouteRuleInput) => routingApi.upsertRule(companyId!, input),
    onSuccess: async (_rule, input) => {
      setRuleErrors((prev) => ({ ...prev, [input.taskClass]: undefined }));
      await invalidateRules();
    },
    onError: (error, input) => {
      setRuleErrors((prev) => ({ ...prev, [input.taskClass]: describeRoutingError(error) }));
    },
  });

  // --- default matrix -------------------------------------------------------

  const [defaults, setDefaults] = useState({
    longFeatureOwnerProfileId: "",
    fastBugWorkerProfileId: "",
    invariantSpecialistProfileId: "",
    advisorReviewerProfileId: "",
    mechanicalPoolProfileId: "",
  });
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [defaultsResult, setDefaultsResult] = useState<RouteRuleDefaultsResult | null>(null);

  const applyDefaultsMutation = useMutation({
    mutationFn: () =>
      routingApi.applyDefaultRules(companyId!, {
        longFeatureOwnerProfileId: defaults.longFeatureOwnerProfileId,
        fastBugWorkerProfileId: defaults.fastBugWorkerProfileId,
        invariantSpecialistProfileId: defaults.invariantSpecialistProfileId,
        advisorReviewerProfileId: defaults.advisorReviewerProfileId,
        mechanicalPoolProfileId: defaults.mechanicalPoolProfileId || null,
      }),
    onSuccess: async (result) => {
      setDefaultsError(null);
      setDefaultsResult(result);
      setRuleDrafts({});
      await invalidateRules();
    },
    onError: (error) => setDefaultsError(describeRoutingError(error)),
  });

  if (!companyId) {
    return <div className="text-sm text-muted-foreground">Select a company first.</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Routing</h1>
        <p className="text-sm text-muted-foreground">
          Execution profiles and deterministic task-attempt route rules for this company.
        </p>
      </div>

      <section className="space-y-3" aria-label="Execution profiles">
        <h2 className="text-sm font-semibold">Execution profiles</h2>
        {profileError ? (
          <div role="alert" className="text-xs text-destructive">{profileError}</div>
        ) : null}
        {profilesQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading profiles...</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Name</th>
                <th className="py-1 pr-2 font-medium">Family</th>
                <th className="py-1 pr-2 font-medium">Agent</th>
                <th className="py-1 pr-2 font-medium">Model</th>
                <th className="py-1 pr-2 font-medium">Effort</th>
                <th className="py-1 pr-2 font-medium">Roles</th>
                <th className="py-1 pr-2 font-medium">Enabled</th>
                <th className="py-1 pr-2 font-medium">Max concurrent</th>
                <th className="py-1 font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) =>
                editingProfileId === profile.id ? (
                  <tr key={profile.id} className="border-t border-border">
                    <td colSpan={9} className="py-2">
                      <ProfileForm
                        value={editForm}
                        onChange={setEditForm}
                        agents={agents}
                        idPrefix={`Edit ${profile.name}`}
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={updateProfileMutation.isPending}
                          onClick={() =>
                            updateProfileMutation.mutate({
                              profile,
                              patch: {
                                name: editForm.name,
                                providerFamily: editForm.providerFamily,
                                agentId: editForm.agentId,
                                model: editForm.model,
                                effort: editForm.effort,
                                roleCapabilities: editForm.roleCapabilities,
                                maxConcurrentAttempts: editForm.maxConcurrentAttempts,
                              },
                            })}
                        >
                          Save profile
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingProfileId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={profile.id} className="border-t border-border">
                    <td className="py-1.5 pr-2">{profile.name}</td>
                    <td className="py-1.5 pr-2">{profile.providerFamily}</td>
                    <td className="py-1.5 pr-2">{agentName(profile.agentId)}</td>
                    <td className="py-1.5 pr-2">{profile.model}</td>
                    <td className="py-1.5 pr-2">{profile.effort}</td>
                    <td className="py-1.5 pr-2">{profile.roleCapabilities.join(", ")}</td>
                    <td className="py-1.5 pr-2">{profile.enabled ? "Enabled" : "Disabled"}</td>
                    <td className="py-1.5 pr-2">{profile.maxConcurrentAttempts}</td>
                    <td className="py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updateProfileMutation.isPending}
                          onClick={() =>
                            updateProfileMutation.mutate({ profile, patch: { enabled: !profile.enabled } })}
                        >
                          {profile.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingProfileId(profile.id);
                            setEditForm({
                              name: profile.name,
                              providerFamily: profile.providerFamily,
                              agentId: profile.agentId,
                              model: profile.model,
                              effort: profile.effort,
                              roleCapabilities: [...profile.roleCapabilities],
                              maxConcurrentAttempts: profile.maxConcurrentAttempts,
                            });
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
              {profiles.length === 0 ? (
                <tr className="border-t border-border">
                  <td colSpan={9} className="py-2 text-muted-foreground">No execution profiles yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
        <div className="rounded-md border border-border p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            New profile
          </h3>
          <ProfileForm value={createForm} onChange={setCreateForm} agents={agents} idPrefix="New" />
          {createError ? (
            <div role="alert" className="mt-2 text-xs text-destructive">{createError}</div>
          ) : null}
          <Button
            className="mt-2"
            size="sm"
            disabled={createProfileMutation.isPending}
            onClick={() => createProfileMutation.mutate()}
          >
            Create profile
          </Button>
        </div>
      </section>

      <section className="space-y-3" aria-label="Route rules">
        <h2 className="text-sm font-semibold">Route rules</h2>
        {rulesQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading rules...</div>
        ) : (
          <div className="space-y-2">
            {TASK_CLASSES.map((taskClass) => {
              const existing = rules.find((rule) => rule.taskClass === taskClass);
              const draft = ruleDrafts[taskClass] ?? (existing ? draftFromRule(existing) : EMPTY_RULE_DRAFT);
              const setDraft = (next: RuleDraft) =>
                setRuleDrafts((prev) => ({ ...prev, [taskClass]: next }));
              const error = ruleErrors[taskClass];
              return (
                <div key={taskClass} className="rounded-md border border-border p-3" data-task-class={taskClass}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">{taskClass}</span>
                    <Button
                      size="sm"
                      disabled={upsertRuleMutation.isPending}
                      onClick={() => upsertRuleMutation.mutate(draftToInput(taskClass, draft, existing))}
                    >
                      Save rule
                    </Button>
                  </div>
                  {error ? (
                    <div role="alert" className="mb-2 text-xs text-destructive">{error}</div>
                  ) : null}
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Worker
                      <ProfileSelect
                        label={`${taskClass} worker`}
                        value={draft.workerProfileId}
                        onChange={(v) => setDraft({ ...draft, workerProfileId: v })}
                        profiles={profiles}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Advisor
                      <ProfileSelect
                        label={`${taskClass} advisor`}
                        value={draft.advisorProfileId}
                        onChange={(v) => setDraft({ ...draft, advisorProfileId: v })}
                        profiles={profiles}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Advisor mode
                      <select
                        aria-label={`${taskClass} advisor mode`}
                        className={selectClass}
                        value={draft.advisorMode}
                        onChange={(e) => setDraft({ ...draft, advisorMode: e.target.value as RouteAdvisorMode })}
                      >
                        {(["none", "optional", "required"] as const).map((mode) => (
                          <option key={mode} value={mode}>{mode}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Reviewer
                      <ProfileSelect
                        label={`${taskClass} reviewer`}
                        value={draft.reviewerProfileId}
                        onChange={(v) => setDraft({ ...draft, reviewerProfileId: v })}
                        profiles={profiles}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Reviewer fallback
                      <ProfileSelect
                        label={`${taskClass} reviewer fallback`}
                        value={draft.reviewerFallbackProfileId}
                        onChange={(v) => setDraft({ ...draft, reviewerFallbackProfileId: v })}
                        profiles={profiles}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Review requirement
                      <select
                        aria-label={`${taskClass} review requirement`}
                        className={selectClass}
                        value={draft.reviewRequirement}
                        onChange={(e) =>
                          setDraft({ ...draft, reviewRequirement: e.target.value as RouteReviewRequirement })}
                      >
                        {(["always", "consequential", "none"] as const).map((requirement) => (
                          <option key={requirement} value={requirement}>{requirement}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Fallback policy
                      <select
                        aria-label={`${taskClass} reviewer fallback policy`}
                        className={selectClass}
                        value={draft.reviewerFallbackPolicy}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            reviewerFallbackPolicy: e.target.value as RouteReviewerFallbackPolicy,
                          })}
                      >
                        {(["fallback", "fail_closed"] as const).map((policy) => (
                          <option key={policy} value={policy}>{policy}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Rescue
                      <ProfileSelect
                        label={`${taskClass} rescue`}
                        value={draft.rescueProfileId}
                        onChange={(v) => setDraft({ ...draft, rescueProfileId: v })}
                        profiles={profiles}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Max attempts
                      <input
                        aria-label={`${taskClass} max attempts`}
                        type="number"
                        min={1}
                        max={10}
                        className={numberClass}
                        value={draft.maxAttempts}
                        onChange={(e) => setDraft({ ...draft, maxAttempts: Number(e.target.value) })}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Wall clock (min)
                      <input
                        aria-label={`${taskClass} max wall clock minutes`}
                        type="number"
                        min={5}
                        className={numberClass}
                        value={draft.maxWallClockMinutes}
                        onChange={(e) => setDraft({ ...draft, maxWallClockMinutes: Number(e.target.value) })}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Max cost (¢)
                      <input
                        aria-label={`${taskClass} max cost cents`}
                        type="number"
                        min={0}
                        className={numberClass}
                        value={draft.maxCostCents}
                        placeholder="none"
                        onChange={(e) => setDraft({ ...draft, maxCostCents: e.target.value })}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="Apply default matrix">
        <h2 className="text-sm font-semibold">Apply default matrix</h2>
        <p className="text-xs text-muted-foreground">
          Bind the four required authority slots (and an optional mechanical pool) to write the
          initial route-rule matrix for every task class.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {([
            ["longFeatureOwnerProfileId", "Long feature owner"],
            ["fastBugWorkerProfileId", "Fast bug worker"],
            ["invariantSpecialistProfileId", "Invariant specialist"],
            ["advisorReviewerProfileId", "Advisor / reviewer"],
            ["mechanicalPoolProfileId", "Mechanical pool (optional)"],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {label}
              <ProfileSelect
                label={label}
                value={defaults[key]}
                onChange={(v) => setDefaults((prev) => ({ ...prev, [key]: v }))}
                profiles={profiles}
              />
            </label>
          ))}
        </div>
        {defaultsError ? (
          <div role="alert" className="text-xs text-destructive">{defaultsError}</div>
        ) : null}
        {defaultsResult && defaultsResult.unresolvedTaskClasses.length > 0 ? (
          <div role="status" className="text-xs text-muted-foreground">
            Unresolved task classes: {defaultsResult.unresolvedTaskClasses.join(", ")}
          </div>
        ) : null}
        {defaultsResult && defaultsResult.unresolvedTaskClasses.length === 0 ? (
          <div role="status" className="text-xs text-muted-foreground">
            Default matrix applied to {defaultsResult.rules.length} task classes.
          </div>
        ) : null}
        <Button
          size="sm"
          disabled={applyDefaultsMutation.isPending}
          onClick={() => applyDefaultsMutation.mutate()}
        >
          Apply default matrix
        </Button>
      </section>
    </div>
  );
}

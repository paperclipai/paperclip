import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import type { ToolProfileWithDetails } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { toolsApi, type ToolProfileBindingInput } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/context/ToastContext";
import { LoadingState } from "../shared";
import {
  buildEntries,
  countAllowedTools,
  parseEntries,
  templateSelections,
  TEMPLATES,
  type AdvancedRule,
  type TemplateKey,
  type WizardSelections,
} from "./profile-model";
import { useProfilesData } from "./useProfilesData";
import { WizardToolsStep } from "./WizardToolsStep";
import { readWizardMeta, resumeStep, withWizardMeta, type WizardStep } from "./wizard-draft";

function slugifyProfileKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

const STEP_LABELS: Array<{ step: WizardStep; label: string }> = [
  { step: 1, label: "Name" },
  { step: 2, label: "Choose tools" },
  { step: 3, label: "Assign" },
];

export function ProfileWizard({
  companyId,
  profileId,
  initialTemplate,
}: {
  companyId: string;
  profileId?: string;
  initialTemplate?: TemplateKey;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const data = useProfilesData(companyId);
  const { appGroups, catalog, profiles, agents } = data;

  const allProfiles = profiles.data?.profiles ?? [];
  const existing = profileId ? allProfiles.find((p) => p.id === profileId) ?? null : null;

  const [step, setStep] = useState<WizardStep>(1);
  const [draftId, setDraftId] = useState<string | null>(profileId ?? null);
  const [template, setTemplate] = useState<TemplateKey | null>(initialTemplate ?? null);
  const [copyFromId, setCopyFromId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [profileKey, setProfileKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [selections, setSelections] = useState<WizardSelections>({});
  const [advancedRules, setAdvancedRules] = useState<AdvancedRule[]>([]);
  const [newToolsAction, setNewToolsAction] = useState<"deny" | "allow">("deny");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [selectedRoutineIds, setSelectedRoutineIds] = useState<Set<string>>(new Set());
  const [companyDefault, setCompanyDefault] = useState(false);

  const toggleIn = (setter: typeof setSelectedAgentIds) => (id: string) =>
    setter((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Hydrate once when resuming an existing draft and its catalog is loaded.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !existing || appGroups.length === 0) return;
    if (existing.id !== profileId) return;
    hydrated.current = true;
    setName(existing.name);
    setDescription(existing.description ?? "");
    setProfileKey(existing.profileKey);
    setKeyEdited(true);
    setNewToolsAction(existing.defaultAction);
    const parsed = parseEntries(appGroups, existing.entries);
    setSelections(parsed.selections);
    setAdvancedRules(parsed.advancedRules);
    const meta = readWizardMeta(existing);
    setTemplate(meta?.template ?? null);
    // Drafts resume at the first unfinished step; a finished profile being
    // edited starts at step 1 so the admin can review the whole thing.
    setStep(existing.status === "draft" ? resumeStep(meta) : 1);
    const targetIds = (type: string) =>
      new Set(existing.bindings.filter((b) => b.targetType === type).map((b) => b.targetId));
    setSelectedAgentIds(targetIds("agent"));
    setSelectedProjectIds(targetIds("project"));
    setSelectedRoutineIds(targetIds("routine"));
    setCompanyDefault(existing.bindings.some((b) => b.targetType === "company"));
  }, [existing, appGroups, profileId]);

  // Key auto-derives from the name until the admin overrides it in Advanced.
  useEffect(() => {
    if (!keyEdited) setProfileKey(slugifyProfileKey(name));
  }, [name, keyEdited]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(companyId) });
  };

  const live = useMemo(
    () => countAllowedTools(appGroups, selections, newToolsAction, catalog.length),
    [appGroups, selections, newToolsAction, catalog.length],
  );

  // Map step-1 template choice onto concrete per-app selections (needs the catalog).
  const seedSelections = (): WizardSelections => {
    if (template === "copy" && copyFromId) {
      const source = allProfiles.find((p) => p.id === copyFromId);
      if (source) return parseEntries(appGroups, source.entries).selections;
    }
    if (template && template !== "copy") return templateSelections(template, appGroups);
    return selections;
  };

  const saveDraft = useMutation({
    mutationFn: async (input: {
      goToStep: WizardStep;
      completedStep: WizardStep;
      seed?: WizardSelections;
    }) => {
      const effSelections = input.seed ?? selections;
      const entries = buildEntries(appGroups, effSelections, advancedRules);
      const metadata = withWizardMeta(existing?.metadata ?? null, {
        lastCompletedStep: input.completedStep,
        template,
      });
      if (!draftId) {
        const created = await toolsApi.createProfile(companyId, {
          profileKey: profileKey || slugifyProfileKey(name) || "profile",
          name: name.trim() || "Untitled profile",
          description: description.trim() || null,
          status: "draft",
          defaultAction: newToolsAction,
          entries,
          metadata,
        });
        return { created, goToStep: input.goToStep, seed: input.seed };
      }
      const updated = await toolsApi.updateProfile(draftId, {
        profileKey: profileKey || undefined,
        name: name.trim() || "Untitled profile",
        description: description.trim() || null,
        defaultAction: newToolsAction,
        entries,
        metadata,
      });
      return { created: updated, goToStep: input.goToStep, seed: input.seed };
    },
    onSuccess: ({ created, goToStep, seed }) => {
      setDraftId(created.id);
      if (seed) setSelections(seed);
      setStep(goToStep);
      invalidate();
    },
    onError: (error: unknown) =>
      pushToast({ title: "Could not save", body: String((error as Error)?.message ?? error), tone: "error" }),
  });

  const finish = useMutation({
    mutationFn: async () => {
      if (!draftId) throw new Error("No draft to finish");
      const entries = buildEntries(appGroups, selections, advancedRules);
      const profile = await toolsApi.updateProfile(draftId, {
        status: "active",
        defaultAction: newToolsAction,
        entries,
        metadata: withWizardMeta(existing?.metadata ?? null, { lastCompletedStep: 3, template }),
      });
      await reconcileBindings(companyId, profile, {
        agentIds: [...selectedAgentIds],
        projectIds: [...selectedProjectIds],
        routineIds: [...selectedRoutineIds],
        companyDefault,
      });
      return profile;
    },
    onSuccess: () => {
      pushToast({ title: "Profile saved", tone: "success" });
      invalidate();
      // TODO(PAP-10997 follow-up): once the profile detail route
      // (/apps/advanced/profiles/:id) lands, navigate there instead of the index.
      navigate("/apps/advanced/profiles");
    },
    onError: (error: unknown) =>
      pushToast({ title: "Could not save profile", body: String((error as Error)?.message ?? error), tone: "error" }),
  });

  const saveAndExit = () => {
    const completed: WizardStep = step;
    saveDraft.mutate(
      { goToStep: step, completedStep: completed },
      {
        onSuccess: () => {
          pushToast({ title: "Draft saved", body: "Pick it back up from the profiles list.", tone: "success" });
          navigate("/apps/advanced/profiles");
        },
      },
    );
  };

  const busy = saveDraft.isPending || finish.isPending;
  const step1Valid = name.trim().length > 0 && (template !== "copy" || Boolean(copyFromId));

  if (profileId && profiles.isLoading) return <LoadingState label="Loading draft…" />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-24">
      <Stepper current={step} />

      <div className="min-h-[320px]">
        {step === 1 ? (
          <StepName
            template={template}
            onTemplate={setTemplate}
            copyFromId={copyFromId}
            onCopyFrom={setCopyFromId}
            copyOptions={allProfiles.filter((p) => p.status !== "archived" && p.id !== profileId)}
            name={name}
            onName={setName}
            description={description}
            onDescription={setDescription}
            profileKey={profileKey}
            onProfileKey={(v) => {
              setKeyEdited(true);
              setProfileKey(v);
            }}
          />
        ) : null}

        {step === 2 ? (
          <WizardToolsStep
            appGroups={appGroups}
            catalogLoading={data.catalogLoading}
            selections={selections}
            onSelectionsChange={setSelections}
            advancedRules={advancedRules}
            onAdvancedRulesChange={setAdvancedRules}
            newToolsAction={newToolsAction}
            onNewToolsActionChange={setNewToolsAction}
          />
        ) : null}

        {step === 3 ? (
          <StepAssign
            agents={(agents.data ?? []).map((a) => ({ id: a.id, name: a.name }))}
            projects={(data.projects.data ?? []).map((p) => ({ id: p.id, name: p.name }))}
            routines={(data.routines.data ?? []).map((r) => ({ id: r.id, name: r.title }))}
            profiles={allProfiles}
            selectedAgentIds={selectedAgentIds}
            onToggleAgent={toggleIn(setSelectedAgentIds)}
            selectedProjectIds={selectedProjectIds}
            onToggleProject={toggleIn(setSelectedProjectIds)}
            selectedRoutineIds={selectedRoutineIds}
            onToggleRoutine={toggleIn(setSelectedRoutineIds)}
            companyDefault={companyDefault}
            onCompanyDefault={setCompanyDefault}
          />
        ) : null}
      </div>

      {/* Sticky footer: live count + navigation. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {step >= 2 ? (
              <span>
                Allows <span className="font-medium text-foreground">{live.allowed}</span> of {live.total}{" "}
                tools
              </span>
            ) : null}
            {draftId ? (
              <button
                type="button"
                onClick={saveAndExit}
                disabled={busy}
                className="font-medium text-primary hover:underline disabled:opacity-50"
              >
                Save &amp; finish later
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {step > 1 ? (
              <Button variant="outline" disabled={busy} onClick={() => setStep((s) => (s - 1) as WizardStep)}>
                Back
              </Button>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={() => navigate("/apps/advanced/profiles")}>
                Cancel
              </Button>
            )}

            {step === 1 ? (
              <Button
                disabled={!step1Valid || busy}
                onClick={() =>
                  saveDraft.mutate({ goToStep: 2, completedStep: 1, seed: seedSelections() })
                }
              >
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Continue
              </Button>
            ) : null}

            {step === 2 ? (
              <Button
                disabled={busy}
                onClick={() => saveDraft.mutate({ goToStep: 3, completedStep: 2 })}
              >
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Continue
              </Button>
            ) : null}

            {step === 3 ? (
              <Button disabled={busy} onClick={() => finish.mutate()}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Save profile
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Reconcile the profile's assignments against the wizard's step-3 choices. */
async function reconcileBindings(
  companyId: string,
  profile: ToolProfileWithDetails,
  desired: { agentIds: string[]; projectIds: string[]; routineIds: string[]; companyDefault: boolean },
) {
  const want = new Map<string, ToolProfileBindingInput>();
  if (desired.companyDefault) want.set(`company:${companyId}`, { targetType: "company", targetId: companyId });
  for (const id of desired.agentIds) want.set(`agent:${id}`, { targetType: "agent", targetId: id });
  for (const id of desired.projectIds) want.set(`project:${id}`, { targetType: "project", targetId: id });
  for (const id of desired.routineIds) want.set(`routine:${id}`, { targetType: "routine", targetId: id });

  // Only the target types the wizard manages are reconciled — leave any
  // issue-scoped or other bindings untouched.
  const managed = new Set(["company", "agent", "project", "routine"]);
  const have = new Set(profile.bindings.map((b) => `${b.targetType}:${b.targetId}`));

  await Promise.all([
    ...[...want.entries()]
      .filter(([k]) => !have.has(k))
      .map(([, input]) => toolsApi.bindProfile(companyId, profile.id, input)),
    ...profile.bindings
      .filter((b) => managed.has(b.targetType) && !want.has(`${b.targetType}:${b.targetId}`))
      .map((b) => toolsApi.unbindProfile(companyId, profile.id, { targetType: b.targetType, targetId: b.targetId })),
  ]);
}

function Stepper({ current }: { current: WizardStep }) {
  return (
    <ol className="flex items-center gap-2 text-sm">
      {STEP_LABELS.map(({ step, label }, idx) => {
        const done = current > step;
        const active = current === step;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                active && "bg-primary text-primary-foreground",
                done && "bg-primary/20 text-primary",
                !active && !done && "bg-muted text-muted-foreground",
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : step}
            </span>
            <span className={cn("font-medium", active ? "text-foreground" : "text-muted-foreground")}>
              {label}
            </span>
            {idx < STEP_LABELS.length - 1 ? <span className="mx-1 text-muted-foreground">→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function StepName({
  template,
  onTemplate,
  copyFromId,
  onCopyFrom,
  copyOptions,
  name,
  onName,
  description,
  onDescription,
  profileKey,
  onProfileKey,
}: {
  template: TemplateKey | null;
  onTemplate: (key: TemplateKey) => void;
  copyFromId: string | null;
  onCopyFrom: (id: string) => void;
  copyOptions: ToolProfileWithDetails[];
  name: string;
  onName: (v: string) => void;
  description: string;
  onDescription: (v: string) => void;
  profileKey: string;
  onProfileKey: (v: string) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Start from</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTemplate(t.key)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border px-4 py-3 text-left transition-colors",
                template === t.key
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:border-primary/40 hover:bg-accent/40",
              )}
            >
              <span className="text-sm font-medium text-foreground">{t.title}</span>
              <span className="text-xs text-muted-foreground">{t.description}</span>
            </button>
          ))}
        </div>
      </div>

      {template === "copy" ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">Which profile?</h3>
          {copyOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">You don't have another profile to copy yet.</p>
          ) : (
            <div className="space-y-1.5">
              {copyOptions.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2"
                >
                  <input
                    type="radio"
                    name="copy-from"
                    checked={copyFromId === p.id}
                    onChange={() => onCopyFrom(p.id)}
                  />
                  <span className="text-sm font-medium text-foreground">{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="e.g. Everyday work"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-description">Description (optional)</Label>
          <Textarea
            id="profile-description"
            value={description}
            onChange={(e) => onDescription(e.target.value)}
            placeholder="What is this profile for?"
            rows={2}
          />
        </div>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="profile-key">Identifier</Label>
            <Input
              id="profile-key"
              value={profileKey}
              onChange={(e) => onProfileKey(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Used in exports and the API. Auto-filled from the name.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

interface TargetOption {
  id: string;
  name: string;
}

export function StepAssign({
  agents,
  projects = [],
  routines = [],
  profiles,
  selectedAgentIds,
  onToggleAgent,
  selectedProjectIds,
  onToggleProject,
  selectedRoutineIds,
  onToggleRoutine,
  companyDefault,
  onCompanyDefault,
}: {
  agents: TargetOption[];
  projects?: TargetOption[];
  routines?: TargetOption[];
  profiles: ToolProfileWithDetails[];
  selectedAgentIds: Set<string>;
  onToggleAgent: (id: string) => void;
  selectedProjectIds?: Set<string>;
  onToggleProject?: (id: string) => void;
  selectedRoutineIds?: Set<string>;
  onToggleRoutine?: (id: string) => void;
  companyDefault: boolean;
  onCompanyDefault: (v: boolean) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  // Per-agent overlap context from already-loaded bindings — no extra fetch.
  const contextByAgent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of profiles) {
      for (const b of p.bindings) {
        if (b.targetType === "agent") {
          const list = map.get(b.targetId) ?? [];
          list.push(p.name);
          map.set(b.targetId, list);
        }
      }
    }
    return map;
  }, [profiles]);

  const defaultProfileName = profiles.find((p) => p.summary.isCompanyDefault)?.name ?? null;

  return (
    <div className="space-y-5">
      <label className="flex items-start gap-3 rounded-lg border border-border p-4">
        <input
          type="checkbox"
          className="mt-1"
          checked={companyDefault}
          onChange={(e) => onCompanyDefault(e.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Make this the company default</span>
          <span className="text-xs text-muted-foreground">
            Every agent without its own profile uses this one.
            {defaultProfileName ? ` Replaces “${defaultProfileName}”.` : ""}
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Assign to agents</h3>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {agents.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">No agents yet.</p>
          ) : (
            agents.map((agent) => {
              const context = contextByAgent.get(agent.id) ?? [];
              const bits = [...context];
              if (defaultProfileName) bits.push("company default");
              return (
                <label key={agent.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selectedAgentIds.has(agent.id)}
                    onChange={() => onToggleAgent(agent.id)}
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">{agent.name}</span>
                    {bits.length > 0 ? (
                      <span className="text-xs text-muted-foreground">already has: {bits.join(" · ")}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground/70">no profiles yet</span>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          If an agent has several profiles, it can use anything any of them allows.
        </p>
      </div>

      {(projects.length > 0 || routines.length > 0) && onToggleProject && onToggleRoutine ? (
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen} className="rounded-lg border border-border">
          <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left">
            <span className="text-sm font-medium text-foreground">More targets</span>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", moreOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Assign this profile to a whole project or a scheduled routine instead of (or as well as)
              individual agents.
            </p>
            <TargetChecklist
              label="Projects"
              options={projects}
              selected={selectedProjectIds ?? new Set()}
              onToggle={onToggleProject}
            />
            <TargetChecklist
              label="Routines"
              options={routines}
              selected={selectedRoutineIds ?? new Set()}
              onToggle={onToggleRoutine}
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function TargetChecklist({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: TargetOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((option) => (
          <label key={option.id} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={selected.has(option.id)} onChange={() => onToggle(option.id)} />
            {option.name}
          </label>
        ))}
      </div>
    </div>
  );
}

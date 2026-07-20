import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createResourceSchema, type Resource, type CompanySecret } from "@paperclipai/shared";
import { Database, Pencil, Plus, Archive, AlertCircle, X } from "lucide-react";
import { resourcesApi, type ResourceMutationInput } from "@/api/resources";
import { secretsApi } from "@/api/secrets";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

type LabelEntry = { key: string; value: string };
export type ResourceDraft = Omit<ResourceMutationInput, "labels"> & { labels: LabelEntry[] };

const emptyDraft: ResourceDraft = {
  key: "",
  type: "git",
  repository: "",
  sourcePath: "",
  defaultRef: "main",
  mountPath: "",
  credentialRef: null,
  labels: [],
};

function draftFromResource(resource: Resource): ResourceDraft {
  return {
    key: resource.key,
    type: "git",
    repository: resource.repository,
    sourcePath: resource.sourcePath ?? "",
    defaultRef: resource.defaultRef,
    mountPath: resource.mountPath,
    credentialRef: resource.credentialRef,
    labels: Object.entries(resource.labels).map(([key, value]) => ({ key, value })),
  };
}

export function toResourcePayload(draft: ResourceDraft): ResourceMutationInput {
  const labels = Object.fromEntries(
    draft.labels
      .map(({ key, value }) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
  return {
    key: draft.key.trim(),
    type: "git",
    repository: draft.repository.trim(),
    sourcePath: draft.sourcePath?.trim() || null,
    defaultRef: draft.defaultRef.trim(),
    mountPath: draft.mountPath.trim(),
    credentialRef: draft.credentialRef || null,
    labels,
  };
}

export function validateResourceDraft(draft: ResourceDraft): string | null {
  const result = createResourceSchema.safeParse(toResourcePayload(draft));
  return result.success ? null : result.error.issues[0]?.message ?? "Invalid Resource configuration.";
}

function SecretOption({ secret }: { secret: CompanySecret }) {
  return (
    <option value={secret.id}>
      {secret.name} · {secret.provider}
    </option>
  );
}

function ResourceForm({
  open,
  resource,
  secrets,
  pending,
  error,
  onOpenChange,
  onSubmit,
  onCreateSecret,
}: {
  open: boolean;
  resource: Resource | null;
  secrets: CompanySecret[];
  pending: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: ResourceMutationInput) => void;
  onCreateSecret: (input: { name: string; value: string; description?: string | null }) => Promise<CompanySecret>;
}) {
  const [draft, setDraft] = useState<ResourceDraft>(emptyDraft);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretDescription, setSecretDescription] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(resource ? draftFromResource(resource) : { ...emptyDraft, labels: [] });
    setValidationError(null);
    setSecretDialogOpen(false);
    setSecretName("");
    setSecretValue("");
    setSecretDescription("");
    setSecretError(null);
  }, [open, resource]);

  const update = <K extends keyof ResourceDraft>(key: K, value: ResourceDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidationError(null);
  };

  const submit = () => {
    const localError = validateResourceDraft(draft);
    if (localError) {
      setValidationError(localError);
      return;
    }
    onSubmit(toResourcePayload(draft));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(90vh,48rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{resource ? "Edit Resource" : "Add Resource"}</DialogTitle>
          <DialogDescription>
            Configure a reusable Git source for workflow workspaces. Bizbox stores metadata; Git owns the files.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Key" hint="Stable manifest-friendly identifier.">
            <Input value={draft.key} onChange={(event) => update("key", event.target.value)} disabled={!!resource} />
          </Field>
          <Field label="Type">
            <Input value="git" disabled aria-label="Resource type" />
          </Field>
          <Field label="Repository" className="sm:col-span-2">
            <Input value={draft.repository} onChange={(event) => update("repository", event.target.value)} placeholder="https://github.com/org/repository.git" />
          </Field>
          <Field label="Source path" hint="Optional repository subdirectory.">
            <Input value={draft.sourcePath ?? ""} onChange={(event) => update("sourcePath", event.target.value)} placeholder="content" />
          </Field>
          <Field label="Default ref" hint="Branch, tag, commit, or latest-compatible branch name.">
            <Input value={draft.defaultRef} onChange={(event) => update("defaultRef", event.target.value)} placeholder="main" />
          </Field>
          <Field label="Mount path" hint="Authoritative relative path inside each run workspace." className="sm:col-span-2">
            <Input value={draft.mountPath} onChange={(event) => update("mountPath", event.target.value)} placeholder="campaign-context" />
          </Field>
          <Field label="Credential" hint="Only secret metadata is shown. The secret value never reaches the UI.">
            <div className="flex gap-2">
              <select
                aria-label="Credential"
                value={draft.credentialRef ?? ""}
                onChange={(event) => update("credentialRef", event.target.value || null)}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">No credential</option>
                {secrets.map((secret) => <SecretOption key={secret.id} secret={secret} />)}
              </select>
              <Button type="button" variant="outline" size="sm" onClick={() => { setSecretError(null); setSecretDialogOpen(true); }}>Add secret</Button>
            </div>
          </Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Labels</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => update("labels", [...draft.labels, { key: "", value: "" }])}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add label
            </Button>
          </div>
          {draft.labels.map((entry, index) => (
            <div key={`${index}-${entry.key}`} className="flex gap-2">
              <Input aria-label={`Label ${index + 1} key`} placeholder="key" value={entry.key} onChange={(event) => update("labels", draft.labels.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} />
              <Input aria-label={`Label ${index + 1} value`} placeholder="value" value={entry.value} onChange={(event) => update("labels", draft.labels.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove label ${index + 1}`} onClick={() => update("labels", draft.labels.filter((_, itemIndex) => itemIndex !== index))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {(validationError || error) && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{validationError ?? error}</span>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={pending}>{pending ? "Saving..." : resource ? "Save changes" : "Create Resource"}</Button>
        </DialogFooter>
      </DialogContent>
      <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add secret</DialogTitle>
            <DialogDescription>Create a company secret for this Resource. The value is sent to the secure secret service and is not shown again.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Name"><Input value={secretName} onChange={(event) => { setSecretName(event.target.value); setSecretError(null); }} placeholder="github-campaign-token" /></Field>
            <Field label="Secret value"><Input type="password" autoComplete="new-password" value={secretValue} onChange={(event) => { setSecretValue(event.target.value); setSecretError(null); }} placeholder="Paste token or credential" /></Field>
            <Field label="Description"><Input value={secretDescription} onChange={(event) => setSecretDescription(event.target.value)} placeholder="Used by campaign repository" /></Field>
            {secretError && <div role="alert" className="text-sm text-destructive">{secretError}</div>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSecretDialogOpen(false)}>Cancel</Button>
            <Button
              type="button"
              disabled={!secretName.trim() || !secretValue || pending}
              onClick={async () => {
                try {
                  const created = await onCreateSecret({ name: secretName.trim(), value: secretValue, description: secretDescription.trim() || null });
                  update("credentialRef", created.id);
                  setSecretValue("");
                  setSecretDialogOpen(false);
                } catch (createError) {
                  setSecretError(createError instanceof Error ? createError.message : "Failed to create secret.");
                }
              }}
            >
              {pending ? "Saving..." : "Create secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-xs text-muted-foreground">{label}{hint ? ` · ${hint}` : ""}</Label>
      {children}
    </div>
  );
}

export function Resources() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Resource | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Resources" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const resourcesQuery = useQuery({
    queryKey: queryKeys.resources.list(selectedCompanyId ?? "", includeArchived),
    queryFn: () => resourcesApi.list(selectedCompanyId!, includeArchived),
    enabled: !!selectedCompanyId,
  });
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(selectedCompanyId ?? ""),
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && formOpen,
  });
  const invalidateResources = () => queryClient.invalidateQueries({ queryKey: queryKeys.resources.all(selectedCompanyId!) });
  const saveMutation = useMutation({
    mutationFn: (payload: ResourceMutationInput) => editingResource ? resourcesApi.update(editingResource.id, payload) : resourcesApi.create(selectedCompanyId!, payload),
    onSuccess: async () => {
      await invalidateResources();
      setFormOpen(false);
      pushToast({ title: editingResource ? "Resource updated" : "Resource created", tone: "success" });
    },
  });
  const createSecretMutation = useMutation({
    mutationFn: (input: { name: string; value: string; description?: string | null }) =>
      secretsApi.create(selectedCompanyId!, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
    },
  });
  const archiveMutation = useMutation({
    mutationFn: (resource: Resource) => resourcesApi.archive(resource.id),
    onSuccess: async () => {
      await invalidateResources();
      setArchiveTarget(null);
      pushToast({ title: "Resource archived", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to archive Resource",
        body: error instanceof Error ? error.message : "Unable to archive this Resource.",
        tone: "error",
      });
    },
  });

  const resources = useMemo(() => resourcesQuery.data ?? [], [resourcesQuery.data]);
  const openCreate = () => { setEditingResource(null); saveMutation.reset(); setFormOpen(true); };
  const openEdit = (resource: Resource) => { setEditingResource(resource); saveMutation.reset(); setFormOpen(true); };

  if (!selectedCompanyId) return <div className="p-6 text-sm text-muted-foreground">Select a company to manage Resources.</div>;
  if (resourcesQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Resources</h1>
          <p className="mt-1 text-sm text-muted-foreground">Reusable company sources mounted into workflow workspaces.</p>
        </div>
        <Button onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" /> Add Resource</Button>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox id="include-archived" checked={includeArchived} onCheckedChange={(checked) => setIncludeArchived(checked === true)} />
        <label htmlFor="include-archived">Include archived</label>
      </div>
      {resourcesQuery.error ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">Failed to load Resources: {resourcesQuery.error instanceof Error ? resourcesQuery.error.message : "Unknown error"}</div>
      ) : resources.length === 0 ? (
        <EmptyState icon={Database} message={includeArchived ? "No Resources found." : "No active Resources yet."} action="Add Resource" onAction={openCreate} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>{["Key", "Type", "Repository", "Source path", "Default ref", "Mount path", "Credential", "Status", ""].map((heading) => <th key={heading} className="px-3 py-2 font-medium">{heading}</th>)}</tr>
            </thead>
            <tbody>
              {resources.map((resource) => (
                <tr key={resource.id} className="border-t border-border align-top hover:bg-muted/20">
                  <td className="px-3 py-3 font-mono text-xs font-medium">{resource.key}</td>
                  <td className="px-3 py-3"><Badge variant="secondary">{resource.type}</Badge></td>
                  <td className="max-w-[220px] truncate px-3 py-3 font-mono text-xs" title={resource.repository}>{resource.repository}</td>
                  <td className="px-3 py-3 text-muted-foreground">{resource.sourcePath || "—"}</td>
                  <td className="px-3 py-3 font-mono text-xs">{resource.defaultRef}</td>
                  <td className="px-3 py-3 font-mono text-xs">{resource.mountPath}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{resource.credentialRef ? "Configured" : "None"}</td>
                  <td className="px-3 py-3"><StatusBadge status={resource.status} /></td>
                  <td className="px-3 py-3">
                    {resource.status === "active" ? (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" aria-label={`Edit ${resource.key}`} onClick={() => openEdit(resource)}><Pencil className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" aria-label={`Archive ${resource.key}`} onClick={() => setArchiveTarget(resource)}><Archive className="h-4 w-4" /></Button>
                      </div>
                    ) : <span className="text-xs text-muted-foreground">Archived</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ResourceForm
        open={formOpen}
        resource={editingResource}
        secrets={secretsQuery.data ?? []}
        pending={saveMutation.isPending || createSecretMutation.isPending}
        error={saveMutation.error instanceof Error ? saveMutation.error.message : null}
        onOpenChange={setFormOpen}
        onSubmit={(payload) => saveMutation.mutate(payload)}
        onCreateSecret={(input) => createSecretMutation.mutateAsync(input)}
      />
      <Dialog open={!!archiveTarget} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Archive Resource?</DialogTitle><DialogDescription>Archive <strong>{archiveTarget?.key}</strong>? Existing run history remains intact, but new workflow runs cannot use it.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => archiveTarget && archiveMutation.mutate(archiveTarget)} disabled={archiveMutation.isPending}>{archiveMutation.isPending ? "Archiving..." : "Archive Resource"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

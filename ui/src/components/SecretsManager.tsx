import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanySecret,
  CompanySecretAgentReference,
  SecretProvider,
} from "@paperclipai/shared";
import { Edit3, KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
import { secretsApi } from "@/api/secrets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const selectClass =
  "border-input h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

type SecretFormState = {
  name: string;
  value: string;
  description: string;
  provider: SecretProvider | "";
};

function createEmptySecretForm(provider: SecretProvider | "" = ""): SecretFormState {
  return {
    name: "",
    value: "",
    description: "",
    provider,
  };
}

function formatProvider(provider: SecretProvider, labels: Map<SecretProvider, string>) {
  return labels.get(provider) ?? provider;
}

function formatDate(value: Date | string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatAgentReferences(references: CompanySecretAgentReference[]) {
  return references.map((reference) => reference.agentName).join(", ");
}

export function SecretsManager({ companyId }: { companyId: string }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<SecretFormState>(createEmptySecretForm);
  const [editingSecret, setEditingSecret] = useState<CompanySecret | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });
  const [rotatingSecret, setRotatingSecret] = useState<CompanySecret | null>(null);
  const [rotateValue, setRotateValue] = useState("");
  const [deletingSecret, setDeletingSecret] = useState<CompanySecret | null>(null);

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.secrets.providers(companyId),
    queryFn: () => secretsApi.providers(companyId),
  });

  const providerLabels = useMemo(() => {
    return new Map(
      (providersQuery.data ?? []).map((provider) => [
        provider.id,
        provider.label,
      ]),
    );
  }, [providersQuery.data]);
  const defaultProviderId =
    providersQuery.data?.find((provider) => !provider.requiresExternalRef)?.id ??
    providersQuery.data?.[0]?.id ??
    "";

  useEffect(() => {
    if (!defaultProviderId) return;
    setCreateForm((current) =>
      current.provider ? current : { ...current, provider: defaultProviderId },
    );
  }, [defaultProviderId]);

  async function refreshSecrets() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: createForm.name.trim(),
        value: createForm.value,
        provider: createForm.provider || undefined,
        description: createForm.description.trim() || null,
      }),
    onSuccess: async (secret) => {
      setCreateOpen(false);
      setCreateForm(createEmptySecretForm(defaultProviderId));
      await refreshSecrets();
      pushToast({
        title: "Secret created",
        body: `${secret.name} is available to agents.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create secret",
        body: getErrorMessage(error, "Secret creation failed."),
        tone: "error",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editingSecret) throw new Error("No secret selected");
      return secretsApi.update(editingSecret.id, {
        name: editForm.name.trim(),
        description: editForm.description.trim() || null,
      });
    },
    onSuccess: async (secret) => {
      setEditingSecret(null);
      await refreshSecrets();
      pushToast({
        title: "Secret updated",
        body: `${secret.name} metadata was saved.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update secret",
        body: getErrorMessage(error, "Secret update failed."),
        tone: "error",
      });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: () => {
      if (!rotatingSecret) throw new Error("No secret selected");
      return secretsApi.rotate(rotatingSecret.id, { value: rotateValue });
    },
    onSuccess: async (secret) => {
      setRotatingSecret(null);
      setRotateValue("");
      await refreshSecrets();
      pushToast({
        title: "Secret rotated",
        body: `${secret.name} is now on version ${secret.latestVersion}.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to rotate secret",
        body: getErrorMessage(error, "Secret rotation failed."),
        tone: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!deletingSecret) throw new Error("No secret selected");
      return secretsApi.remove(deletingSecret.id);
    },
    onSuccess: async () => {
      const deletedName = deletingSecret?.name ?? "Secret";
      setDeletingSecret(null);
      await refreshSecrets();
      pushToast({
        title: "Secret deleted",
        body: `${deletedName} was removed.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete secret",
        body: getErrorMessage(error, "Secret deletion failed."),
        tone: "error",
      });
    },
  });

  const createNameValid = SECRET_NAME_PATTERN.test(createForm.name.trim());
  const editNameValid = SECRET_NAME_PATTERN.test(editForm.name.trim());
  const canCreate =
    createNameValid && Boolean(createForm.provider) && createForm.value.length > 0;
  const canUpdate = Boolean(editingSecret) && editNameValid;
  const canRotate = Boolean(rotatingSecret) && rotateValue.length > 0;

  function startEdit(secret: CompanySecret) {
    setEditingSecret(secret);
    setEditForm({
      name: secret.name,
      description: secret.description ?? "",
    });
  }

  function startRotate(secret: CompanySecret) {
    setRotatingSecret(secret);
    setRotateValue("");
  }

  const secrets = secretsQuery.data ?? [];
  const loading = secretsQuery.isLoading || providersQuery.isLoading;
  const queryError = secretsQuery.error ?? providersQuery.error;
  const deleteUsage = deletingSecret?.agentReferences ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Secrets
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Store company-level credentials once, then reference them from agents and projects.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setCreateForm((current) =>
              current.provider ? current : { ...current, provider: defaultProviderId },
            );
            setCreateOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Create secret
        </Button>
      </div>

      <div className="rounded-md border border-border">
        {queryError ? (
          <div className="px-4 py-6 text-sm text-destructive">
            {getErrorMessage(queryError, "Failed to load secrets.")}
          </div>
        ) : loading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading secrets...</div>
        ) : secrets.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <KeyRound className="mx-auto h-8 w-8 text-muted-foreground" />
            <div className="mt-3 text-sm font-medium">No secrets yet</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Create the first secret before selecting secret references in env config.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[54rem] text-left text-sm">
              <caption className="sr-only">Company secrets</caption>
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 font-medium">Version</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Usage</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {secrets.map((secret) => {
                  const usage = secret.agentReferences ?? [];
                  return (
                    <tr key={secret.id}>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">
                        {secret.name}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {formatProvider(secret.provider, providerLabels)}
                      </td>
                      <td className="max-w-[16rem] px-4 py-3 text-xs text-muted-foreground">
                        <span className="line-clamp-2">
                          {secret.description || "No description"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">v{secret.latestVersion}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatDate(secret.createdAt)}
                      </td>
                      <td className="max-w-[14rem] px-4 py-3 text-xs text-muted-foreground">
                        {usage.length === 0 ? (
                          "No agent refs"
                        ) : (
                          <span className="line-clamp-2">
                            {formatAgentReferences(usage)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => startRotate(secret)}
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                            Rotate
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => startEdit(secret)}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeletingSecret(secret)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={(next) => !createMutation.isPending && setCreateOpen(next)}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canCreate) createMutation.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create secret</DialogTitle>
              <DialogDescription>
                Secret values are encrypted and are not shown again after creation.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="secret-create-provider">Provider</Label>
                <select
                  id="secret-create-provider"
                  className={selectClass}
                  value={createForm.provider}
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      provider: event.target.value as SecretProvider,
                    }))
                  }
                  disabled={providersQuery.isLoading}
                >
                  <option value="" disabled>
                    Select provider...
                  </option>
                  {(providersQuery.data ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secret-create-name">Name</Label>
                <Input
                  id="secret-create-name"
                  value={createForm.name}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="POSTGRES_URL"
                  aria-invalid={createForm.name.length > 0 && !createNameValid}
                />
                {createForm.name.length > 0 && !createNameValid ? (
                  <p className="text-xs text-destructive">
                    Use letters, numbers, and underscores. The first character must be a letter or underscore.
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secret-create-value">Value</Label>
                <Input
                  id="secret-create-value"
                  type="password"
                  value={createForm.value}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, value: event.target.value }))
                  }
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secret-create-description">Description</Label>
                <Textarea
                  id="secret-create-description"
                  value={createForm.description}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, description: event.target.value }))
                  }
                  placeholder="Optional note"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={createMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canCreate || createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create secret"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingSecret)} onOpenChange={(next) => !updateMutation.isPending && !next && setEditingSecret(null)}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canUpdate) updateMutation.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Edit secret</DialogTitle>
              <DialogDescription>
                This updates metadata only. Use rotate to change the encrypted value.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="secret-edit-name">Name</Label>
                <Input
                  id="secret-edit-name"
                  value={editForm.name}
                  onChange={(event) =>
                    setEditForm((current) => ({ ...current, name: event.target.value }))
                  }
                  aria-invalid={editForm.name.length > 0 && !editNameValid}
                />
                {editForm.name.length > 0 && !editNameValid ? (
                  <p className="text-xs text-destructive">
                    Use letters, numbers, and underscores. The first character must be a letter or underscore.
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secret-edit-description">Description</Label>
                <Textarea
                  id="secret-edit-description"
                  value={editForm.description}
                  onChange={(event) =>
                    setEditForm((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditingSecret(null)}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canUpdate || updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(rotatingSecret)} onOpenChange={(next) => !rotateMutation.isPending && !next && setRotatingSecret(null)}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canRotate) rotateMutation.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rotate secret</DialogTitle>
              <DialogDescription>
                {rotatingSecret
                  ? `${rotatingSecret.name} will move from version ${rotatingSecret.latestVersion} to version ${rotatingSecret.latestVersion + 1}.`
                  : "Enter a new encrypted value."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="secret-rotate-value">New value</Label>
              <Input
                id="secret-rotate-value"
                type="password"
                value={rotateValue}
                onChange={(event) => setRotateValue(event.target.value)}
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRotatingSecret(null)}
                disabled={rotateMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canRotate || rotateMutation.isPending}>
                {rotateMutation.isPending ? "Rotating..." : "Rotate secret"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingSecret)} onOpenChange={(next) => !deleteMutation.isPending && !next && setDeletingSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete secret</DialogTitle>
            <DialogDescription>
              {deletingSecret
                ? `Delete ${deletingSecret.name}? This removes the secret from the company.`
                : "Delete this secret?"}
            </DialogDescription>
          </DialogHeader>
          {deleteUsage.length > 0 ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              Referenced by {deleteUsage.length} agent{deleteUsage.length === 1 ? "" : "s"}:{" "}
              {formatAgentReferences(deleteUsage)}.
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeletingSecret(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

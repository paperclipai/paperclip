import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { KeyRound, Pencil, RotateCw, Trash2 } from "lucide-react";
import { Field } from "../components/agent-config-primitives";
import type { CompanySecret, SecretProvider } from "@paperclipai/shared";

export function CompanySecrets() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  // --- Create form state ---
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newProvider, setNewProvider] = useState<SecretProvider>("local_encrypted");
  const [newDescription, setNewDescription] = useState("");

  // --- Edit state ---
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // --- Rotate state ---
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");

  // Reset form state when company changes
  const resetForms = useCallback(() => {
    setNewName("");
    setNewValue("");
    setNewDescription("");
    setEditingId(null);
    setRotatingId(null);
    setRotateValue("");
  }, []);

  useEffect(() => {
    resetForms();
  }, [selectedCompanyId, resetForms]);

  // --- Queries ---
  const { data: secrets = [], isLoading } = useQuery({
    queryKey: queryKeys.secrets.list(selectedCompanyId!),
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: providers = [] } = useQuery({
    queryKey: queryKeys.secrets.providers(selectedCompanyId!),
    queryFn: () => secretsApi.providers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Sync default provider when providers data loads
  useEffect(() => {
    if (providers.length > 0 && !providers.some((p) => p.id === newProvider)) {
      setNewProvider(providers[0]!.id);
    }
  }, [providers, newProvider]);

  // --- Mutations ---
  const invalidateSecrets = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });

  const createMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(selectedCompanyId!, {
        name: newName.trim(),
        value: newValue,
        provider: newProvider,
        description: newDescription.trim() || null,
      }),
    onSuccess: () => {
      setNewName("");
      setNewValue("");
      setNewDescription("");
      pushToast({ title: "Secret created" });
      invalidateSecrets();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name, description }: { id: string; name: string; description: string }) =>
      secretsApi.update(id, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      setEditingId(null);
      pushToast({ title: "Secret updated" });
      invalidateSecrets();
    },
  });

  const rotateMutation = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      secretsApi.rotate(id, { value }),
    onSuccess: () => {
      setRotatingId(null);
      setRotateValue("");
      pushToast({ title: "Secret rotated" });
      invalidateSecrets();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: () => {
      pushToast({ title: "Secret deleted" });
      invalidateSecrets();
    },
  });

  // --- Breadcrumbs ---
  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Secrets" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function startEditing(secret: CompanySecret) {
    setRotatingId(null);
    setRotateValue("");
    setEditingId(secret.id);
    setEditName(secret.name);
    setEditDescription(secret.description ?? "");
  }

  function startRotating(id: string) {
    setEditingId(null);
    setRotatingId(id);
    setRotateValue("");
  }

  function handleDelete(secret: CompanySecret) {
    const confirmed = window.confirm(
      `Delete secret "${secret.name}"? This cannot be undone.`
    );
    if (!confirmed) return;
    deleteMutation.mutate(secret.id);
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Secrets</h1>
      </div>

      {/* Create Secret */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Create Secret
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Name" hint="Environment variable name (e.g. GITHUB_TOKEN).">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
              type="text"
              value={newName}
              placeholder="GITHUB_TOKEN"
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          <Field label="Value" hint="The secret value. Stored encrypted, never displayed again.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
              type="password"
              autoComplete="new-password"
              value={newValue}
              placeholder="••••••••"
              onChange={(e) => setNewValue(e.target.value)}
            />
          </Field>
          <Field label="Provider" hint="Where this secret is stored.">
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value as SecretProvider)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {providers.length === 0 && (
                <option value="local_encrypted">Local Encrypted</option>
              )}
            </select>
          </Field>
          <Field label="Description" hint="Optional description for this secret.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={newDescription}
              placeholder="Optional description"
              onChange={(e) => setNewDescription(e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !newName.trim() || !newValue}
            >
              {createMutation.isPending ? "Creating..." : "Create Secret"}
            </Button>
            {createMutation.isError && (
              <span className="text-xs text-destructive">
                {createMutation.error instanceof Error
                  ? createMutation.error.message
                  : "Failed to create secret"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Secrets List */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Existing Secrets
        </div>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : secrets.length === 0 ? (
          <div className="rounded-md border border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No secrets yet. Create one above.
          </div>
        ) : (
          <div className="space-y-2">
            {secrets.map((secret) => (
              <div
                key={secret.id}
                className="rounded-md border border-border px-4 py-3 space-y-2"
              >
                {/* Secret header row */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono font-medium truncate">
                        {secret.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        v{secret.latestVersion}
                      </span>
                    </div>
                    {secret.description && (
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">
                        {secret.description}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {secret.provider} · created{" "}
                      {new Date(secret.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Edit name/description"
                      onClick={() => startEditing(secret)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Rotate value"
                      onClick={() => startRotating(secret.id)}
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Delete secret"
                      onClick={() => handleDelete(secret)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>

                {/* Inline edit form */}
                {editingId === secret.id && (
                  <div className="space-y-2 border-t border-border pt-2">
                    <Field label="Name">
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </Field>
                    <Field label="Description">
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        type="text"
                        value={editDescription}
                        placeholder="Optional description"
                        onChange={(e) => setEditDescription(e.target.value)}
                      />
                    </Field>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() =>
                          updateMutation.mutate({
                            id: secret.id,
                            name: editName,
                            description: editDescription,
                          })
                        }
                        disabled={updateMutation.isPending || !editName.trim()}
                      >
                        {updateMutation.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                      {updateMutation.isError && (
                        <span className="text-xs text-destructive">
                          {updateMutation.error instanceof Error
                            ? updateMutation.error.message
                            : "Failed to update"}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline rotate form */}
                {rotatingId === secret.id && (
                  <div className="space-y-2 border-t border-border pt-2">
                    <Field label="New value" hint="Enter the new secret value to rotate to.">
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
                        type="password"
                        autoComplete="new-password"
                        value={rotateValue}
                        placeholder="••••••••"
                        onChange={(e) => setRotateValue(e.target.value)}
                      />
                    </Field>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() =>
                          rotateMutation.mutate({
                            id: secret.id,
                            value: rotateValue,
                          })
                        }
                        disabled={rotateMutation.isPending || !rotateValue}
                      >
                        {rotateMutation.isPending ? "Rotating..." : "Rotate"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRotatingId(null);
                          setRotateValue("");
                        }}
                      >
                        Cancel
                      </Button>
                      {rotateMutation.isError && (
                        <span className="text-xs text-destructive">
                          {rotateMutation.error instanceof Error
                            ? rotateMutation.error.message
                            : "Failed to rotate"}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

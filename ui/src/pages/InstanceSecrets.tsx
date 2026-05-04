import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret, SecretProvider } from "@paperclipai/shared";
import { KeyRound, Trash2 } from "lucide-react";

import { instanceSecretsApi, secretsApi } from "@/api/secrets";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

const QUERY_KEY = ["instance-secrets"];
const PROVIDERS_KEY = ["instance-secret-providers"];

interface CreateForm {
  name: string;
  value: string;
  provider: string;
  description: string;
  externalRef: string;
}

const EMPTY_FORM: CreateForm = {
  name: "",
  value: "",
  provider: "",
  description: "",
  externalRef: "",
};

export function InstanceSecrets() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Secrets" },
    ]);
  }, [setBreadcrumbs]);

  const secretsQuery = useQuery<CompanySecret[]>({
    queryKey: QUERY_KEY,
    queryFn: async () => (await instanceSecretsApi.list()) ?? [],
  });

  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: async () => (await instanceSecretsApi.providers()) ?? [],
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateForm) =>
      instanceSecretsApi.create({
        name: input.name.trim(),
        value: input.value,
        provider: (input.provider || undefined) as SecretProvider | undefined,
        description: input.description.trim() || null,
        externalRef: input.externalRef.trim() || null,
      }),
    onSuccess: (created) => {
      setActionError(null);
      setForm(EMPTY_FORM);
      setCreatedId(created?.id ?? null);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to create secret.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to delete secret.");
    },
  });

  const canSubmit = form.name.trim().length > 0 && form.value.length > 0 && !createMutation.isPending;
  const secrets = secretsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl">
      <header className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Instance secrets</h1>
      </header>

      <p className="text-sm text-muted-foreground">
        Instance secrets are shared across every company. Use for shared OAuth client credentials,
        provider API keys, etc. Per-company credentials belong in each company&apos;s settings page.
        Reference an instance secret from a plugin&apos;s instance config by its UUID — the resolver
        doesn&apos;t care about scope.
      </p>

      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <section className="rounded-md border border-border bg-card p-4 flex flex-col gap-3">
        <h2 className="text-sm font-medium">Create secret</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="Globally unique within the instance scope.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="gcp_workspace_oauth_client_secret"
            />
          </Field>
          <Field label="Provider" hint="Defaults to the server-configured provider.">
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={form.provider}
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
            >
              <option value="">Default</option>
              {(providersQuery.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Value" hint="Stored encrypted at rest.">
            <textarea
              className="h-24 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              placeholder="(secret material)"
            />
          </Field>
          <Field label="Description" hint="Optional human note.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="GCP OAuth client used by the workspace plugin"
            />
          </Field>
          <Field label="External ref" hint="Provider-specific reference (ARN / vault path).">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={form.externalRef}
              onChange={(e) => setForm((f) => ({ ...f, externalRef: e.target.value }))}
              placeholder=""
            />
          </Field>
        </div>
        <div>
          <Button size="sm" disabled={!canSubmit} onClick={() => createMutation.mutate(form)}>
            {createMutation.isPending ? "Creating..." : "Create instance secret"}
          </Button>
        </div>
        {createdId ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Created. UUID: <code className="font-mono">{createdId}</code> — paste this into a
            plugin&apos;s instance config field marked <code>secret-ref</code>.
          </div>
        ) : null}
      </section>

      <section className="rounded-md border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">{secrets.length} instance secret{secrets.length === 1 ? "" : "s"}</h2>
        </header>
        {secretsQuery.isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : secrets.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No instance secrets yet. Create one above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="px-4 py-2 font-medium">UUID</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    <div className="font-medium">{s.name}</div>
                    {s.description ? (
                      <div className="text-xs text-muted-foreground">{s.description}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{s.provider}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">v{s.latestVersion}</td>
                  <td className="px-4 py-2"><code className="font-mono text-xs">{s.id}</code></td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (confirm(`Delete instance secret "${s.name}"? This cannot be undone.`)) {
                          deleteMutation.mutate(s.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted-foreground/70">{hint}</span> : null}
    </label>
  );
}

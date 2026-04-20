import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, CompanySecret, SecretProvider } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { secretsApi } from "../api/secrets";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { CopyText } from "../components/CopyText";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field } from "../components/agent-config-primitives";
import { KeyRound, Plus, RotateCw, Pencil, Trash2, Shield, Copy } from "lucide-react";

const inputClass = "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

function formatDate(d: Date | string) {
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function providerLabel(provider: SecretProvider) {
  const labels: Record<SecretProvider, string> = {
    local_encrypted: "Local Encrypted",
    aws_secrets_manager: "AWS Secrets Manager",
    gcp_secret_manager: "GCP Secret Manager",
    vault: "Vault",
  };
  return labels[provider] ?? provider;
}

/* ---- Create Secret Dialog ---- */

function CreateSecretDialog({
  open,
  onOpenChange,
  companyId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: name.trim(),
        value,
        description: description.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      onOpenChange(false);
      setName("");
      setValue("");
      setDescription("");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Secret</DialogTitle>
          <DialogDescription>The value will be encrypted and cannot be viewed after creation.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Field label="Name" hint="Unique identifier for this secret.">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. OPENAI_API_KEY"
            />
          </Field>
          <Field label="Value" hint="The secret value. Write-only — cannot be viewed after creation.">
            <input
              className={inputClass}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Secret value"
            />
          </Field>
          <Field label="Description" hint="Optional description for this secret.">
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || !value || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
        {mutation.isError && (
          <p className="text-xs text-destructive mt-1">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to create secret"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---- Edit Metadata Dialog ---- */

function EditSecretDialog({
  secret,
  onClose,
  companyId,
}: {
  secret: CompanySecret | null;
  onClose: () => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (secret) {
      setName(secret.name);
      setDescription(secret.description ?? "");
    }
  }, [secret]);

  const mutation = useMutation({
    mutationFn: () =>
      secretsApi.update(secret!.id, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      onClose();
    },
  });

  return (
    <Dialog open={!!secret} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Secret</DialogTitle>
          <DialogDescription>
            Update the name or description. The value cannot be changed here — use rotate instead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
        {mutation.isError && (
          <p className="text-xs text-destructive mt-1">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to update"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---- Rotate Secret Dialog ---- */

function RotateSecretDialog({
  secret,
  onClose,
  companyId,
}: {
  secret: CompanySecret | null;
  onClose: () => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (secret) setValue("");
  }, [secret]);

  const mutation = useMutation({
    mutationFn: () => secretsApi.rotate(secret!.id, { value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      onClose();
      setValue("");
    },
  });

  return (
    <Dialog open={!!secret} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate Secret</DialogTitle>
          <DialogDescription>
            Set a new value for <strong>{secret?.name}</strong>. This creates version {(secret?.latestVersion ?? 0) + 1}
            . The old value will no longer be used.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Field label="New value" hint="The new secret value. Write-only.">
            <input
              className={inputClass}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="New secret value"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!value || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Rotating..." : "Rotate"}
          </Button>
        </DialogFooter>
        {mutation.isError && (
          <p className="text-xs text-destructive mt-1">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to rotate"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---- Delete Confirmation Dialog ---- */

function DeleteSecretDialog({
  secret,
  onClose,
  companyId,
}: {
  secret: CompanySecret | null;
  onClose: () => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => secretsApi.remove(secret!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      onClose();
    },
  });

  return (
    <Dialog open={!!secret} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Secret</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{secret?.name}</strong>? This action cannot be undone. Any agent
            environment variables referencing this secret will break.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
        {mutation.isError && (
          <p className="text-xs text-destructive mt-1">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to delete"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---- Helpers: extract secret usage from agents ---- */

/** Build a map of secretId → list of agents that reference it in their env config */
function buildSecretUsageMap(agents: Agent[]): Map<string, { agent: Agent; envKeys: string[] }[]> {
  const map = new Map<string, { agent: Agent; envKeys: string[] }[]>();
  for (const agent of agents) {
    const env = (agent.adapterConfig as Record<string, unknown>)?.env;
    if (!env || typeof env !== "object") continue;
    for (const [key, binding] of Object.entries(env as Record<string, unknown>)) {
      if (binding && typeof binding === "object" && (binding as { type?: string }).type === "secret_ref") {
        const secretId = (binding as { secretId?: string }).secretId;
        if (!secretId) continue;
        const existing = map.get(secretId);
        if (existing) {
          const agentEntry = existing.find((e) => e.agent.id === agent.id);
          if (agentEntry) agentEntry.envKeys.push(key);
          else existing.push({ agent, envKeys: [key] });
        } else {
          map.set(secretId, [{ agent, envKeys: [key] }]);
        }
      }
    }
  }
  return map;
}

/* ---- Secret Row ---- */

function SecretRow({
  secret,
  usedBy,
  onEdit,
  onRotate,
  onDelete,
}: {
  secret: CompanySecret;
  usedBy?: { agent: Agent; envKeys: string[] }[];
  onEdit: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0 hover:bg-accent/30 transition-colors">
      <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{secret.name}</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            v{secret.latestVersion}
          </span>
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            {providerLabel(secret.provider)}
          </span>
        </div>
        {secret.description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{secret.description}</p>}
        <div className="flex items-center gap-2 mt-0.5">
          <CopyText
            text={secret.id}
            copiedLabel="Copied ID!"
            className="text-[11px] text-muted-foreground/60 font-mono hover:text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1">
              <Copy className="h-2.5 w-2.5" />
              {secret.id.slice(0, 8)}…
            </span>
          </CopyText>
          <span className="text-[11px] text-muted-foreground/60">·</span>
          <span className="text-[11px] text-muted-foreground/60">
            Created {formatDate(secret.createdAt)}
            {secret.updatedAt !== secret.createdAt && <> · Updated {formatDate(secret.updatedAt)}</>}
          </span>
        </div>
        {usedBy && usedBy.length > 0 && (
          <p className="text-[11px] text-muted-foreground/80 mt-1">
            Used by:{" "}
            {usedBy.map((entry, i) => (
              <span key={entry.agent.id}>
                {i > 0 && ", "}
                <span className="font-medium">{entry.agent.name}</span>
                <span className="text-muted-foreground/60"> ({entry.envKeys.join(", ")})</span>
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="icon-sm" onClick={onEdit} title="Edit metadata">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onRotate} title="Rotate value">
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          title="Delete secret"
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/* ---- Main Page ---- */

export function CompanySecrets() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [showCreate, setShowCreate] = useState(false);
  const [editSecret, setEditSecret] = useState<CompanySecret | null>(null);
  const [rotateSecret, setRotateSecret] = useState<CompanySecret | null>(null);
  const [deleteSecret, setDeleteSecret] = useState<CompanySecret | null>(null);

  const { data: secrets, isLoading } = useQuery({
    queryKey: queryKeys.secrets.list(selectedCompanyId!),
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const secretUsageMap = useMemo(() => (agents ? buildSecretUsageMap(agents) : new Map()), [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: selectedCompany?.name ?? "Company", href: "/dashboard" }, { label: "Secrets" }]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany || !selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Secrets</h1>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Secret
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Manage encrypted secrets for your company. Secret values are write-only and cannot be viewed after creation.
        Agents reference secrets in their environment variable configuration.
      </p>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading secrets...</div>
      ) : !secrets || secrets.length === 0 ? (
        <div className="rounded-md border border-border px-4 py-8 text-center">
          <Shield className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No secrets yet.</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Create a secret to securely store API keys and credentials.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-border">
          {secrets.map((secret) => (
            <SecretRow
              key={secret.id}
              secret={secret}
              usedBy={secretUsageMap.get(secret.id)}
              onEdit={() => setEditSecret(secret)}
              onRotate={() => setRotateSecret(secret)}
              onDelete={() => setDeleteSecret(secret)}
            />
          ))}
        </div>
      )}

      <CreateSecretDialog open={showCreate} onOpenChange={setShowCreate} companyId={selectedCompanyId} />
      <EditSecretDialog secret={editSecret} onClose={() => setEditSecret(null)} companyId={selectedCompanyId} />
      <RotateSecretDialog secret={rotateSecret} onClose={() => setRotateSecret(null)} companyId={selectedCompanyId} />
      <DeleteSecretDialog secret={deleteSecret} onClose={() => setDeleteSecret(null)} companyId={selectedCompanyId} />
    </div>
  );
}

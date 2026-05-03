import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { KeyRound, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { ApiError } from "@/api/client";
import { secretsApi } from "@/api/secrets";
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
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { cn, relativeTime } from "@/lib/utils";

type DialogMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "rotate"; secret: CompanySecret }
  | { kind: "edit"; secret: CompanySecret }
  | { kind: "delete"; secret: CompanySecret };

const COMPANY_SECRETS_QUERY_KEY = "company-secrets";

export function CompanySecrets() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogMode>({ kind: "closed" });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Secrets" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: secrets, isLoading } = useQuery({
    queryKey: selectedCompanyId
      ? [COMPANY_SECRETS_QUERY_KEY, selectedCompanyId]
      : [COMPANY_SECRETS_QUERY_KEY, "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  function invalidateList() {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({
      queryKey: [COMPANY_SECRETS_QUERY_KEY, selectedCompanyId],
    });
  }

  function handleApiError(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    pushToast({ tone: "error", title: fallback, body: message });
  }

  return (
    <div
      className="max-w-5xl space-y-6"
      data-testid="company-settings-secrets-section"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Company Secrets</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Encrypted values that agents can reference from environment variables.
          Rotate to change a secret's value; delete to remove it from the company
          library.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {secrets?.length ?? 0} secret{secrets?.length === 1 ? "" : "s"}
        </p>
        <Button
          size="sm"
          onClick={() => setDialog({ kind: "create" })}
          disabled={!selectedCompanyId}
        >
          New secret
        </Button>
      </div>

      <div className="rounded-md border border-border">
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : !secrets || secrets.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No secrets yet. Use <span className="font-medium">New secret</span> to
            create one, or seal a plain env var from the agent configuration page.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {secrets.map((secret) => (
              <li
                key={secret.id}
                className="flex items-start gap-4 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono font-medium">{secret.name}</div>
                  {secret.description ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {secret.description}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-muted-foreground/70">
                    v{secret.latestVersion} · last rotated{" "}
                    {relativeTime(secret.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDialog({ kind: "rotate", secret })}
                    title="Rotate value"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDialog({ kind: "edit", secret })}
                    title="Edit name and description"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDialog({ kind: "delete", secret })}
                    title="Delete secret"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialog.kind === "create" && selectedCompanyId ? (
        <CreateSecretDialog
          companyId={selectedCompanyId}
          onClose={() => setDialog({ kind: "closed" })}
          onCreated={(name) => {
            pushToast({ tone: "success", title: `Secret "${name}" created` });
            invalidateList();
            setDialog({ kind: "closed" });
          }}
          onError={(error) => handleApiError(error, "Failed to create secret")}
        />
      ) : null}

      {dialog.kind === "rotate" ? (
        <RotateSecretDialog
          secret={dialog.secret}
          onClose={() => setDialog({ kind: "closed" })}
          onRotated={() => {
            pushToast({
              tone: "success",
              title: `Secret "${dialog.secret.name}" rotated`,
            });
            invalidateList();
            setDialog({ kind: "closed" });
          }}
          onError={(error) => handleApiError(error, "Failed to rotate secret")}
        />
      ) : null}

      {dialog.kind === "edit" ? (
        <EditSecretDialog
          secret={dialog.secret}
          onClose={() => setDialog({ kind: "closed" })}
          onSaved={(name) => {
            pushToast({ tone: "success", title: `Secret "${name}" updated` });
            invalidateList();
            setDialog({ kind: "closed" });
          }}
          onError={(error) => handleApiError(error, "Failed to update secret")}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <DeleteSecretDialog
          secret={dialog.secret}
          onClose={() => setDialog({ kind: "closed" })}
          onDeleted={() => {
            pushToast({
              tone: "success",
              title: `Secret "${dialog.secret.name}" deleted`,
            });
            invalidateList();
            setDialog({ kind: "closed" });
          }}
        />
      ) : null}
    </div>
  );
}

function CreateSecretDialog({
  companyId,
  onClose,
  onCreated,
  onError,
}: {
  companyId: string;
  onClose: () => void;
  onCreated: (name: string) => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: name.trim(),
        value,
        description: description.trim() || null,
      }),
    onSuccess: () => onCreated(name.trim()),
    onError,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New secret</DialogTitle>
          <DialogDescription>
            Stored encrypted; visible to agents only when referenced from a
            secret-typed environment variable.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Name</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="API_TOKEN"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Value</label>
            <Textarea
              rows={4}
              className="font-mono"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="paste secret value"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Description (optional)</label>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this secret is used for"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || !value || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotateSecretDialog({
  secret,
  onClose,
  onRotated,
  onError,
}: {
  secret: CompanySecret;
  onClose: () => void;
  onRotated: () => void;
  onError: (error: unknown) => void;
}) {
  const [value, setValue] = useState("");

  const rotate = useMutation({
    mutationFn: () => secretsApi.rotate(secret.id, { value }),
    onSuccess: onRotated,
    onError,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rotate "{secret.name}"</DialogTitle>
          <DialogDescription>
            Stores a new version. Agents that reference this secret will pick up
            the new value on their next run.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <label className="text-xs font-medium">New value</label>
          <Textarea
            rows={5}
            className="font-mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="paste new value"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Current version: v{secret.latestVersion}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => rotate.mutate()}
            disabled={!value || rotate.isPending}
          >
            {rotate.isPending ? "Rotating…" : "Rotate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditSecretDialog({
  secret,
  onClose,
  onSaved,
  onError,
}: {
  secret: CompanySecret;
  onClose: () => void;
  onSaved: (name: string) => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(secret.name);
  const [description, setDescription] = useState(secret.description ?? "");

  const save = useMutation({
    mutationFn: () =>
      secretsApi.update(secret.id, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => onSaved(name.trim()),
    onError,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit secret</DialogTitle>
          <DialogDescription>
            Changes the metadata. The stored value is unchanged — use Rotate to
            replace the value.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Name</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Description</label>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!name.trim() || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DeleteUsageAgent = { id: string; name: string; envKeys: string[] };
type DeleteUsageSkill = { id: string; name: string; slug: string };
type DeleteBlock = { agents: DeleteUsageAgent[]; skills: DeleteUsageSkill[] };

function DeleteSecretDialog({
  secret,
  onClose,
  onDeleted,
}: {
  secret: CompanySecret;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [blockedBy, setBlockedBy] = useState<DeleteBlock | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => secretsApi.remove(secret.id),
    onSuccess: onDeleted,
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        const body = error.body as
          | { details?: { usedByAgents?: DeleteUsageAgent[]; usedBySkills?: DeleteUsageSkill[] } }
          | null
          | undefined;
        const usedByAgents = body?.details?.usedByAgents ?? [];
        const usedBySkills = body?.details?.usedBySkills ?? [];
        if (
          (Array.isArray(usedByAgents) && usedByAgents.length > 0)
          || (Array.isArray(usedBySkills) && usedBySkills.length > 0)
        ) {
          setBlockedBy({ agents: usedByAgents, skills: usedBySkills });
          setErrorMessage(error.message);
          return;
        }
      }
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to delete secret",
      );
    },
  });

  const totalBlockers = blockedBy ? blockedBy.agents.length + blockedBy.skills.length : 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete "{secret.name}"</DialogTitle>
          <DialogDescription>
            This permanently deletes the secret and all of its versions. Agents
            and skills that reference it will fail until the binding is removed.
          </DialogDescription>
        </DialogHeader>

        {blockedBy && totalBlockers > 0 ? (
          <div className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-3 text-xs">
            <p className="font-medium text-destructive">
              Cannot delete — still referenced by:
            </p>
            <ul className="space-y-1 text-muted-foreground">
              {blockedBy.agents.map((agent) => (
                <li key={`agent:${agent.id}`}>
                  <span className="font-medium text-foreground">{agent.name}</span>{" "}
                  <span className="text-muted-foreground/70">agent</span>{" "}
                  ({agent.envKeys.join(", ")})
                </li>
              ))}
              {blockedBy.skills.map((skill) => (
                <li key={`skill:${skill.id}`}>
                  <span className="font-medium text-foreground">{skill.name}</span>{" "}
                  <span className="text-muted-foreground/70">skill</span>{" "}
                  ({skill.slug})
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Detach this secret from those references first.
            </p>
          </div>
        ) : errorMessage ? (
          <p className={cn("text-xs text-destructive")}>{errorMessage}</p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {blockedBy ? "Close" : "Cancel"}
          </Button>
          {!blockedBy ? (
            <Button
              variant="destructive"
              onClick={() => {
                setErrorMessage(null);
                remove.mutate();
              }}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

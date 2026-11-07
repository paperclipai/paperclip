import { useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecretStatus, UserSecretDefinition } from "@paperclipai/shared";
import { Pencil, Plus, Trash2, UserRound, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { EmptyState } from "../../components/EmptyState";
import { secretsApi } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { useToastActions } from "../../context/ToastContext";
import {
  coverageSummaryLabel,
  secretStatusTone,
  UserSecretChip,
} from "./user-secret-presentation";
import { describeError } from "@/api/errors";

function keyFromName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

interface DefinitionForm {
  name: string;
  key: string;
  description: string;
  usageGuidance: string;
  status: SecretStatus;
}

const emptyForm: DefinitionForm = {
  name: "",
  key: "",
  description: "",
  usageGuidance: "",
  status: "active",
};

/**
 * Secrets → User secret definitions tab (admin). Defines the shared credentials
 * that each member fills in with their own value. Coverage is shown as counts
 * only — never values — per the UX terminology decisions.
 */
export function UserSecretDefinitionsTab({ companyId }: { companyId: string }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserSecretDefinition | null>(null);
  const [form, setForm] = useState<DefinitionForm>(emptyForm);
  const [keyDirty, setKeyDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSecretDefinition | null>(null);

  const definitionsQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitions(companyId),
    queryFn: () => secretsApi.listUserSecretDefinitions(companyId),
  });
  const definitionsView = useQueryView(definitionsQuery);
  const definitions = definitionsQuery.data ?? [];

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setKeyDirty(false);
    setError(null);
    setDialogOpen(true);
  }

  function openEdit(definition: UserSecretDefinition) {
    setEditing(definition);
    setForm({
      name: definition.name,
      key: definition.key,
      description: definition.description ?? "",
      usageGuidance: definition.usageGuidance ?? "",
      status: definition.status,
    });
    setKeyDirty(true);
    setError(null);
    setDialogOpen(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const sharedPayload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        usageGuidance: form.usageGuidance.trim() || null,
      };
      if (editing) {
        return secretsApi.updateUserSecretDefinition(companyId, editing.id, {
          ...sharedPayload,
          status: form.status,
        });
      }
      return secretsApi.createUserSecretDefinition(companyId, {
        ...sharedPayload,
        key: form.key.trim(),
        status: form.status === "deleted" ? "active" : form.status,
      });
    },
    onSuccess: (definition) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({
        title: editing ? translateAgentPage("agents:definition_updated") : translateAgentPage("agents:definition_created"),
        body: definition.name,
        tone: "success",
      });
      setDialogOpen(false);
    },
    onError: (err) =>
      setError(describeError(err).body),
  });

  const remove = useMutation({
    mutationFn: (definition: UserSecretDefinition) =>
      secretsApi.removeUserSecretDefinition(companyId, definition.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({ title: translateAgentPage("agents:definition_removed"), tone: "info" });
      setDeleteTarget(null);
    },
    onError: (err) =>
      pushToast({
        title: translateAgentPage("agents:could_not_remove_definition"),
        body: describeError(err).body,
        tone: "error",
      }),
  });

  const canSave = form.name.trim().length > 0 && form.key.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex items-start gap-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-xs text-violet-800 dark:text-violet-200">
        <UserRound className="h-4 w-4 mt-0.5 shrink-0" />
        <p>{translateAgentPage("agents:define_credentials_that")}{" "}<span className="font-medium">{translateAgentPage("agents:each_member_supplies_for_themselves")}</span>{translateAgentPage("agents:you_set_the_shape_here_every_user_enters")}</p>
      </div>

      <div className="flex items-center justify-end">
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-3.5 w-3.5" />{" "}{translateAgentPage("agents:new_user_secret")}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {definitionsView.kind === "error" ? (
          <div className="py-4">
            <QueryErrorState
              error={definitionsQuery.error}
              action={translateAgentPage("agents:load_definitions")}
              onRetry={definitionsView.retry}
              retrying={definitionsView.isFetching}
            />
          </div>
        ) : definitions.length === 0 && !definitionsQuery.isPending && definitionsView.kind !== "reconnecting" ? (
          <EmptyState
            icon={UserRound}
            message={translateAgentPage("agents:no_user_secret_definitions_yet_create_one_to")}
            action={translateAgentPage("agents:new_user_secret")}
            onAction={openCreate}
          />
        ) : (
          <ul className="space-y-2">
            {definitions.map((definition) => (
              <li
                key={definition.id}
                className="flex items-start gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{definition.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">
                      {definition.key}
                    </code>
                    <UserSecretChip />
                    <Badge
                      variant="outline"
                      className={cn("text-(length:--text-micro)", secretStatusTone(definition.status))}
                    >
                      {definition.status}
                    </Badge>
                  </div>
                  {definition.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">{definition.description}</p>
                  ) : null}
                  <CoverageBadge companyId={companyId} definitionId={definition.id} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(definition)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget(definition)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editing ? translateAgentPage("agents:edit_user_secret") : translateAgentPage("agents:new_user_secret")}
              <UserSecretChip />
            </DialogTitle>
            <DialogDescription>{translateAgentPage("agents:members_supply_their_own_value_for_this_credential")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{translateAgentPage("agents:name")}</label>
              <Input
                value={form.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setForm((current) => ({
                    ...current,
                    name,
                    key: keyDirty ? current.key : keyFromName(name),
                  }));
                }}
                placeholder={translateAgentPage("agents:personal_github_token")}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{translateAgentPage("agents:key")}</label>
              <Input
                value={form.key}
                onChange={(event) => {
                  setKeyDirty(true);
                  setForm((current) => ({ ...current, key: event.target.value }));
                }}
                placeholder={translateAgentPage("agents:personal_gh_token")}
                className="font-mono text-sm"
                disabled={Boolean(editing)}
              />
              <p className="text-(length:--text-micro) text-muted-foreground">{translateAgentPage("agents:stable_identifier_referenced_by_env_bindings")}{" "}{editing ? translateAgentPage("agents:cannot_be_changed") : ""}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{translateAgentPage("agents:description")}</label>
              <Input
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder={translateAgentPage("agents:what_this_credential_is_for")}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{translateAgentPage("agents:usage_guidance")}{" "}<span className="text-muted-foreground">{translateAgentPage("agents:optional_b16c7a")}</span>
              </label>
              <Textarea
                value={form.usageGuidance}
                onChange={(event) =>
                  setForm((current) => ({ ...current, usageGuidance: event.target.value }))
                }
                placeholder={translateAgentPage("agents:tell_members_how_to_create_their_token_required")}
                className="min-h-(--sz-70px) text-sm"
              />
            </div>
            {editing ? (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{translateAgentPage("agents:status")}</label>
                <Select
                  value={form.status}
                  onValueChange={(status) =>
                    setForm((current) => ({ ...current, status: status as SecretStatus }))
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{translateAgentPage("agents:active")}</SelectItem>
                    <SelectItem value="disabled">{translateAgentPage("agents:disabled")}</SelectItem>
                    <SelectItem value="archived">{translateAgentPage("agents:archived")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={save.isPending}>{translateAgentPage("agents:cancel")}</Button>
            <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
              {save.isPending ? translateAgentPage("agents:saving") : editing ? translateAgentPage("agents:save_changes") : translateAgentPage("agents:create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateAgentPage("agents:remove_user_secret")}</DialogTitle>
            <DialogDescription>{translateAgentPage("agents:this_removes_the_definition")}{" "}<span className="font-mono">{deleteTarget?.key}</span>{" "}{translateAgentPage("agents:for_the_whole_company_existing_member_values_become")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={remove.isPending}>{translateAgentPage("agents:cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && remove.mutate(deleteTarget)}
              disabled={remove.isPending}
            >
              {remove.isPending ? translateAgentPage("agents:removing") : translateAgentPage("agents:remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CoverageBadge({
  companyId,
  definitionId,
}: {
  companyId: string;
  definitionId: string;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const coverageQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
    queryFn: () => secretsApi.userSecretDefinitionCoverage(companyId, definitionId),
    staleTime: 30_000,
  });
  const summary = coverageQuery.data;
  const missing = summary ? summary.missingCount : 0;
  return (
    <p className="mt-1 inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
      <Users className="h-3 w-3" />{translateAgentPage("agents:coverage_a721d2")}{" "}{coverageSummaryLabel(summary)}
      {summary && missing > 0 ? (
        <span className="text-amber-600 dark:text-amber-400">· {missing}{" "}{translateAgentPage("agents:not_set")}</span>
      ) : null}
    </p>
  );
}

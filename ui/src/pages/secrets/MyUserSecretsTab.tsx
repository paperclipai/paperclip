import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { AlertCircle, KeyRound, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "../../components/EmptyState";
import { secretsApi, type MyUserSecretEntry } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { useToastActions } from "../../context/ToastContext";
import { SetMyUserSecretDialog } from "./SetMyUserSecretDialog";
import {
  myValueLabel,
  myValueState,
  myValueTone,
} from "./my-value-state";

/**
 * Secrets → My secrets tab. Lists every company user-secret definition paired
 * with the current user's own value state, and lets the user set / update /
 * clear their value. This is the owner-facing counterpart to the admin
 * "User secret definitions" tab.
 */
export function MyUserSecretsTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [dialogFor, setDialogFor] = useState<MyUserSecretEntry | null>(null);

  const mySecretsQuery = useQuery({
    queryKey: queryKeys.secrets.myUserSecrets(companyId),
    queryFn: () => secretsApi.listMyUserSecrets(companyId),
  });
  const entries = mySecretsQuery.data ?? [];

  const clear = useMutation({
    mutationFn: (secret: CompanySecret) => secretsApi.removeMyUserSecret(companyId, secret.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets(companyId) });
      pushToast({ title: "Value cleared", tone: "info" });
    },
    onError: (err) =>
      pushToast({
        title: "Could not clear value",
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      }),
  });

  const missingCount = entries.filter(
    (entry) => entry.definition.status === "active" && !entry.secret,
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex items-start gap-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-xs text-violet-800 dark:text-violet-200">
        <UserRound className="h-4 w-4 mt-0.5 shrink-0" />
        <p>
          These are credentials only you provide. Each value is yours alone — used when you are the
          user responsible for a run — and is never shown back to anyone, including admins.
          {missingCount > 0 ? (
            <span className="font-medium">
              {" "}
              {missingCount} required secret{missingCount === 1 ? " still needs" : "s still need"} your
              value.
            </span>
          ) : null}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mySecretsQuery.isError ? (
          <div className="flex items-center gap-2 py-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> Failed to load your secrets:{" "}
            {(mySecretsQuery.error as Error).message}
            <Button variant="ghost" size="sm" onClick={() => mySecretsQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : entries.length === 0 && !mySecretsQuery.isPending ? (
          <EmptyState
            icon={KeyRound}
            message="No user secrets are defined for this company yet. An admin defines which credentials each member supplies."
          />
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <MyUserSecretRow
                key={entry.definition.id}
                entry={entry}
                onSet={() => setDialogFor(entry)}
                onClear={() => entry.secret && clear.mutate(entry.secret)}
                clearing={clear.isPending}
              />
            ))}
          </ul>
        )}
      </div>

      <SetMyUserSecretDialog
        companyId={companyId}
        definition={dialogFor?.definition ?? null}
        existingSecret={dialogFor?.secret ?? null}
        open={dialogFor !== null}
        onOpenChange={(open) => {
          if (!open) setDialogFor(null);
        }}
      />
    </div>
  );
}

function MyUserSecretRow({
  entry,
  onSet,
  onClear,
  clearing,
}: {
  entry: MyUserSecretEntry;
  onSet: () => void;
  onClear: () => void;
  clearing: boolean;
}) {
  const { definition, secret } = entry;
  const state = myValueState(definition, secret);
  const disabledDefinition = definition.status !== "active";

  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-md border p-3",
        state === "not_set" && !disabledDefinition
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-border",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{definition.name}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {definition.key}
          </code>
          {disabledDefinition ? (
            <Badge variant="outline" className="text-[10px]">
              {definition.status}
            </Badge>
          ) : null}
        </div>
        {definition.description ? (
          <p className="mt-1 text-xs text-muted-foreground">{definition.description}</p>
        ) : null}
        {definition.usageGuidance ? (
          <p className="mt-1 text-[11px] text-muted-foreground/80">{definition.usageGuidance}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" className={cn("text-[11px]", myValueTone(state))}>
          {myValueLabel(state)}
        </Badge>
        {!disabledDefinition ? (
          <Button size="sm" variant={secret ? "outline" : "default"} onClick={onSet}>
            {secret ? "Update" : "Set value"}
          </Button>
        ) : null}
        {secret ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onClear}
            disabled={clearing}
            title="Clear my value"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { Check, KeyRound, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { EmptyState } from "../../components/EmptyState";
import { secretsApi, type MyUserSecretEntry } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";
import { relativeTime } from "../../lib/utils";
import { useToastActions } from "../../context/ToastContext";
import { SetMyUserSecretDialog } from "./SetMyUserSecretDialog";
import { SecretPathName } from "./SecretPathName";
import { myValueState } from "./my-value-state";
import { describeError } from "@/api/errors";

/**
 * Secrets → My secrets tab. Lists every secret the organization asks each
 * member to provide, with whether the signed-in person has added their value,
 * and lets them add, replace or remove it.
 */
export function MyUserSecretsTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [dialogFor, setDialogFor] = useState<MyUserSecretEntry | null>(null);

  const mySecretsQuery = useQuery({
    queryKey: queryKeys.secrets.myUserSecrets(companyId),
    queryFn: () => secretsApi.listMyUserSecrets(companyId),
  });
  const mySecretsView = useQueryView(mySecretsQuery);
  const entries = mySecretsQuery.data ?? [];

  const clear = useMutation({
    mutationFn: (secret: CompanySecret) => secretsApi.removeMyUserSecret(companyId, secret.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets(companyId) });
      pushToast({ title: "Your value was removed", tone: "info" });
    },
    onError: (err) =>
      pushToast({
        title: "Couldn't remove your value",
        body: describeError(err).body,
        tone: "error",
      }),
  });

  const needsValue = (entry: MyUserSecretEntry) =>
    entry.definition.status === "active" && !entry.secret;
  const missingCount = entries.filter(needsValue).length;
  // Secrets still waiting on this person come first; the rest keep the server's order.
  const sortedEntries = [...entries].sort(
    (a, b) => Number(needsValue(b)) - Number(needsValue(a)),
  );

  return (
    <section aria-label="My secrets" className="flex flex-col gap-4">
      <p className="max-w-xl text-sm text-muted-foreground">
        Values only you provide. Agents use them when they work for you.
        {missingCount > 0 ? (
          <span className="text-foreground">
            {" "}
            {missingCount} still {missingCount === 1 ? "needs" : "need"} your value.
          </span>
        ) : null}
      </p>

      {mySecretsView.kind === "error" ? (
        <QueryErrorState
          error={mySecretsQuery.error}
          action="load your secrets"
          onRetry={mySecretsView.retry}
          retrying={mySecretsView.isFetching}
        />
      ) : entries.length === 0 && !mySecretsQuery.isPending && mySecretsView.kind !== "reconnecting" ? (
        <EmptyState
          icon={KeyRound}
          message="Nothing is asked of you yet. An admin decides which secrets each member provides."
        />
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {sortedEntries.map((entry) => (
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

      <SetMyUserSecretDialog
        companyId={companyId}
        definition={dialogFor?.definition ?? null}
        existingSecret={dialogFor?.secret ?? null}
        open={dialogFor !== null}
        onOpenChange={(open) => {
          if (!open) setDialogFor(null);
        }}
      />
    </section>
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
  const replaced = secret ? secret.latestVersion > 1 && secret.lastRotatedAt : null;

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3"
      data-testid={`my-secret-${definition.id}`}
      data-needs-value={!secret && !disabledDefinition ? "true" : undefined}
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <SecretPathName name={definition.name} className="text-sm" />
          {/* Agents point people at a secret by this key, so it stays visible. */}
          <code className="font-mono text-xs text-muted-foreground">{definition.key}</code>
        </span>
        {definition.description ? (
          <span className="text-xs text-muted-foreground">{definition.description}</span>
        ) : null}
        {definition.usageGuidance ? (
          <span className="text-xs text-muted-foreground">{definition.usageGuidance}</span>
        ) : null}
        {disabledDefinition ? (
          <span className="text-xs text-muted-foreground">
            Turned off by an admin. Agents won't ask for it.
          </span>
        ) : state === "inactive" ? (
          <span className="text-xs text-muted-foreground">
            Your value is turned off. Replace it to use it again.
          </span>
        ) : null}
      </div>

      {secret ? (
        <span className="flex items-center gap-1">
          <span className="mr-2 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Check className="size-3.5" aria-hidden />
            {replaced
              ? `Replaced ${relativeTime(replaced)}`
              : `Added ${relativeTime(secret.createdAt)}`}
          </span>
          {!disabledDefinition ? (
            <Button variant="ghost" size="sm" onClick={onSet}>
              Replace
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={`More actions for ${definition.name}`}
                disabled={clearing}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" disabled={clearing} onSelect={onClear}>
                Remove your value
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      ) : !disabledDefinition ? (
        <Button size="sm" onClick={onSet}>
          Set value
        </Button>
      ) : null}
    </li>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { secretsApi, type MyUserSecretEntry } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";
import { SetMyUserSecretDialog } from "./SetMyUserSecretDialog";

/**
 * Warning surface for user secrets the current user has not yet set. Renders
 * nothing when there is nothing missing, so it is safe to embed on task
 * creation / run and issue-failure surfaces. Lets the user satisfy a missing
 * required secret inline via the shared value dialog.
 *
 * Pass `definitionKeys` to scope the warning to a specific set (e.g. the user
 * secrets a blocked run reported as missing); omit it to warn about every
 * active definition the user has not set.
 */
export function MissingUserSecretsBanner({
  companyId,
  definitionKeys,
  title = "Set your user secrets",
  secretsPath,
  className,
}: {
  companyId: string;
  definitionKeys?: string[];
  title?: string;
  /** Optional route to the Secrets → My secrets tab for the "Manage all" link. */
  secretsPath?: string;
  className?: string;
}) {
  const [dialogFor, setDialogFor] = useState<MyUserSecretEntry | null>(null);

  const mySecretsQuery = useQuery({
    queryKey: queryKeys.secrets.myUserSecrets(companyId),
    queryFn: () => secretsApi.listMyUserSecrets(companyId),
    retry: false,
  });

  const keyFilter = definitionKeys ? new Set(definitionKeys) : null;
  const missing = (mySecretsQuery.data ?? []).filter(
    (entry) =>
      entry.definition.status === "active" &&
      !entry.secret &&
      (!keyFilter || keyFilter.has(entry.definition.key)),
  );

  if (missing.length === 0) return null;

  return (
    <div
      className={
        "rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200" +
        (className ? ` ${className}` : "")
      }
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="mt-0.5 text-amber-700/90 dark:text-amber-300/90">
            {missing.length} user secret{missing.length === 1 ? "" : "s"} you are responsible for
            {missing.length === 1 ? " has" : " have"} no value yet. Runs that require
            {missing.length === 1 ? " it" : " them"} will fail until you set your value.
          </p>
          <ul className="mt-2 space-y-1.5">
            {missing.map((entry) => (
              <li
                key={entry.definition.id}
                className="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-background/40 px-2 py-1"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium text-foreground">{entry.definition.name}</span>{" "}
                  <code className="text-[11px] text-muted-foreground">{entry.definition.key}</code>
                </span>
                <Button size="sm" onClick={() => setDialogFor(entry)}>
                  Set value
                </Button>
              </li>
            ))}
          </ul>
          {secretsPath ? (
            <Link
              to={secretsPath}
              className="mt-2 inline-block text-[11px] font-medium underline underline-offset-2"
            >
              Manage all my secrets
            </Link>
          ) : null}
        </div>
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

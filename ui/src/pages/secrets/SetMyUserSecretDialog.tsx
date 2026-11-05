import { useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { secretsApi } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";
import { useToastActions } from "../../context/ToastContext";
import { UserSecretChip } from "./user-secret-presentation";
import { describeError } from "@/api/errors";

/**
 * Shared "set my value" dialog for a user-secret definition. Used both from the
 * Secrets → My secrets tab and from the missing-required-secret warning surfaces
 * (task run / issue failure), so a user can satisfy a required secret from either
 * place with identical behavior.
 */
export function SetMyUserSecretDialog({
  companyId,
  definition,
  existingSecret,
  open,
  onOpenChange,
  onSaved,
}: {
  companyId: string;
  definition: UserSecretDefinition | null;
  existingSecret?: CompanySecret | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (secret: CompanySecret) => void;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [value, setValue] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isExternal = definition?.managedMode === "external_reference";

  useEffect(() => {
    if (open) {
      setValue("");
      setExternalRef("");
      setError(null);
    }
  }, [open, definition?.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (!definition) throw new Error(translateAgentPage("agents:no_definition_selected"));
      const payload = isExternal
        ? { externalRef: externalRef.trim() }
        : { value: value.trim() };
      if (existingSecret) {
        // A stored value already exists → rotate it in place.
        return secretsApi.rotateMyUserSecret(companyId, existingSecret.id, payload);
      }
      return secretsApi.createMyUserSecret(companyId, {
        definitionId: definition.id,
        definitionKey: definition.key,
        ...payload,
      });
    },
    onSuccess: (secret) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({
        title: existingSecret ? translateAgentPage("agents:value_updated") : translateAgentPage("agents:value_saved"),
        body: definition?.name,
        tone: "success",
      });
      onSaved?.(secret);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        describeError(err).body,
      );
    },
  });

  const canSave = isExternal ? externalRef.trim().length > 0 : value.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {existingSecret ? translateAgentPage("agents:update_your_value") : translateAgentPage("agents:set_your_value")}
            <UserSecretChip />
          </DialogTitle>
          <DialogDescription>
            {definition ? (
              <>{translateAgentPage("agents:this_value_is_yours_only_it_is_used")}{" "}<span className="font-mono">{definition.key}</span>.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {definition ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/20 p-3 text-xs">
              <div className="font-medium text-foreground">{definition.name}</div>
              {definition.description ? (
                <p className="mt-1 text-muted-foreground">{definition.description}</p>
              ) : null}
              {definition.usageGuidance ? (
                <p className="mt-1 text-muted-foreground">{definition.usageGuidance}</p>
              ) : null}
            </div>

            {isExternal ? (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{translateAgentPage("agents:external_reference")}</label>
                <Input
                  value={externalRef}
                  onChange={(event) => setExternalRef(event.target.value)}
                  placeholder={translateAgentPage("agents:provider_reference_or_arn")}
                  className="font-mono text-sm"
                  autoFocus
                />
                <p className="text-(length:--text-micro) text-muted-foreground">{translateAgentPage("agents:points_at_your_own_credential_in_the_configured")}</p>
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{translateAgentPage("agents:your_value_990b78")}</label>
                <Textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={translateAgentPage("agents:paste_your_token_or_credential")}
                  className="font-mono text-sm min-h-(--sz-80px)"
                  autoFocus
                />
                <p className="text-(length:--text-micro) text-muted-foreground">{translateAgentPage("agents:stored_encrypted_never_shown_back_to_anyone_including")}</p>
              </div>
            )}

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>{translateAgentPage("agents:cancel")}</Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? translateAgentPage("agents:saving") : existingSecret ? translateAgentPage("agents:update_value") : translateAgentPage("agents:save_value")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

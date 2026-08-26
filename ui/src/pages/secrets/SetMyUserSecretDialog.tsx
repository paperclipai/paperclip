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
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { useToastActions } from "../../context/ToastContext";
import { UserSecretChip } from "./user-secret-presentation";
import { t } from "@/i18n";

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
      if (!definition) throw new Error("No definition selected");
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
        title: existingSecret ? t("app.setMyUserSecretDialog.valueUpdated", { defaultValue: "Value updated" }) : t("app.setMyUserSecretDialog.valueSaved", { defaultValue: "Value saved" }),
        body: definition?.name,
        tone: "success",
      });
      onSaved?.(secret);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("app.setMyUserSecretDialog.failedToSaveValue", { defaultValue: "Failed to save value" }),
      );
    },
  });

  const canSave = isExternal ? externalRef.trim().length > 0 : value.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {existingSecret ? t("app.setMyUserSecretDialog.updateYourValue", { defaultValue: "Update your value" }) : t("app.setMyUserSecretDialog.setYourValue", { defaultValue: "Set your value" })}
            <UserSecretChip />
          </DialogTitle>
          <DialogDescription>
            {definition ? (
              <>
                {t("app.setMyUserSecretDialog.thisValueIsYoursOnlyItIsUsedWhenYouAreTheUserResponsibleForARunThatNeeds", { defaultValue: "This value is yours only. It is used when you are the user responsible for a run that needs" })}<span className="font-mono">{definition.key}</span>.
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
                <label className="text-xs font-medium text-foreground">{t("app.setMyUserSecretDialog.externalReference", { defaultValue: "External reference" })}</label>
                <Input
                  value={externalRef}
                  onChange={(event) => setExternalRef(event.target.value)}
                  placeholder={t("app.setMyUserSecretDialog.providerReferenceOrArn", { defaultValue: "provider reference or ARN" })}
                  className="font-mono text-sm"
                  autoFocus
                />
                <p className="text-(length:--text-micro) text-muted-foreground">
                  {t("app.setMyUserSecretDialog.pointsAtYourOwnCredentialInTheConfiguredProviderPaperclipStoresTheReferenceNotTheValue", { defaultValue: "Points at your own credential in the configured provider. Paperclip stores the reference, not the value." })}</p>
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{t("app.setMyUserSecretDialog.yourValue", { defaultValue: "Your value" })}</label>
                <Textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={t("app.setMyUserSecretDialog.pasteYourTokenOrCredential", { defaultValue: "Paste your token or credential" })}
                  className="font-mono text-sm min-h-(--sz-80px)"
                  autoFocus
                />
                <p className="text-(length:--text-micro) text-muted-foreground">
                  {t("app.setMyUserSecretDialog.storedEncryptedNeverShownBackToAnyoneIncludingAdmins", { defaultValue: "Stored encrypted. Never shown back to anyone, including admins." })}</p>
              </div>
            )}

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? "Saving…" : existingSecret ? t("app.setMyUserSecretDialog.updateValue", { defaultValue: "Update value" }) : t("app.setMyUserSecretDialog.saveValue", { defaultValue: "Save value" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

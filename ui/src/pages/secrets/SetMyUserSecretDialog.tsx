import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { Eye, EyeOff } from "lucide-react";
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
import { describeError } from "@/api/errors";

// Hides the pasted value like a password field while keeping a multi-line box.

/**
 * Shared dialog where a person adds or replaces their own value for a secret.
 * Used both from the Secrets → My secrets tab and from the missing-secret
 * warning surfaces (task run / task failure), so both behave identically.
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
  const [showValue, setShowValue] = useState(false);
  const fieldId = useId();

  const isExternal = definition?.managedMode === "external_reference";

  useEffect(() => {
    if (open) {
      setValue("");
      setExternalRef("");
      setError(null);
      setShowValue(false);
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
        title: existingSecret ? "Your value was replaced" : "Your value was saved",
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
          <DialogTitle>
            {existingSecret ? "Replace your value" : "Set your value"}
            {definition ? ` for ${definition.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            Only you provide this value. Agents use it when they work for you.
          </DialogDescription>
        </DialogHeader>

        {definition ? (
          <div className="flex flex-col gap-3">
            {definition.description || definition.usageGuidance ? (
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                {definition.description ? <p>{definition.description}</p> : null}
                {definition.usageGuidance ? <p>{definition.usageGuidance}</p> : null}
              </div>
            ) : null}

            {isExternal ? (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-foreground" htmlFor={fieldId}>
                  Where your value is stored
                </label>
                <Input
                  id={fieldId}
                  value={externalRef}
                  onChange={(event) => setExternalRef(event.target.value)}
                  placeholder="Reference or ARN"
                  className="font-mono text-sm"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Points to your own secret in your organization's vault. Paperclip saves the
                  reference, not the value.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-foreground" htmlFor={fieldId}>
                  Your value
                </label>
                <div className="relative">
                  <Textarea
                    id={fieldId}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Paste your token or key"
                    className={`min-h-(--sz-80px) pr-11 font-mono text-sm${showValue ? "" : " secret-value-masked"}`}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute right-2 top-2"
                    aria-label={showValue ? "Hide value" : "Show value"}
                    aria-pressed={showValue}
                    onClick={() => setShowValue((current) => !current)}
                  >
                    {showValue ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Encrypted when saved. After that it can be replaced, never viewed.
                </p>
              </div>
            )}

            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? "Saving…" : existingSecret ? "Replace value" : "Save value"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

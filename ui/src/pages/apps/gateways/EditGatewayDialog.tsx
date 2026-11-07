import { useTranslation } from "@/i18n";
import { type FormEvent, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ToolMcpGatewayWithTokens, ToolProfileWithDetails } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/context/ToastContext";
import { allowedToolsLabel } from "./gateway-helpers";
import { gatewaysQueryKey } from "./NewGatewayDialog";
import { describeError } from "@/api/errors";

export function EditGatewayDialog({
  companyId,
  gateway,
  profiles,
  open,
  onOpenChange,
}: {
  companyId: string;
  gateway: ToolMcpGatewayWithTokens;
  profiles: ToolProfileWithDetails[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("connections");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState(gateway.name);
  const [description, setDescription] = useState(gateway.description ?? "");
  const [profileId, setProfileId] = useState(gateway.profileId);

  useEffect(() => {
    if (!open) return;
    setName(gateway.name);
    setDescription(gateway.description ?? "");
    setProfileId(gateway.profileId);
  }, [gateway, open]);

  const activeProfiles = profiles.filter((profile) => profile.status !== "archived");
  const updateMutation = useMutation({
    mutationFn: () =>
      toolsApi.updateGateway(companyId, gateway.id, {
        name: name.trim(),
        description: description.trim() || null,
        profileId,
      }),
    onSuccess: async (updated) => {
      pushToast({ title: t("gateway_updated_2460384"), body: updated.name, tone: "success" });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(companyId) });
      onOpenChange(false);
    },
    onError: (error) => {
      pushToast({
        title: t("gateway_was_not_updated_282216a"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !profileId) return;
    updateMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("edit_gateway_82cad1d")}</DialogTitle>
          <DialogDescription>{t("change_the_label_or_the_access_profile_9f6c721")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("name_709a232")}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("access_profile_e59e8be")}</span>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
              required
            >
              {activeProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} — {allowedToolsLabel(profile)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("description_optional_388de6f")}</span>
            <textarea
              className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("who_this_endpoint_is_for_10c1418")}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("cancel_1791a62")}</Button>
            <Button type="submit" disabled={updateMutation.isPending || !name.trim() || !profileId}>
              {updateMutation.isPending ? t("saving_56a2285") : t("save_changes_179359b")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

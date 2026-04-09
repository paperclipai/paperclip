import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { roomsApi } from "../api/rooms";
import { useT } from "../i18n";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

export function NewRoomDialog() {
  const { t } = useT();
  const { newRoomOpen, closeNewRoom } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const createRoom = useMutation({
    mutationFn: () =>
      roomsApi.create(selectedCompanyId!, {
        name: name.trim(),
        description: description.trim() || null,
      }),
  });

  function reset() {
    setName("");
    setDescription("");
  }

  async function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    try {
      const room = await createRoom.mutateAsync();
      queryClient.invalidateQueries({ queryKey: ["rooms", selectedCompanyId] });
      reset();
      closeNewRoom();
      navigate(`/rooms/${room.id}`);
    } catch {
      // surfaced via createRoom.isError
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog
      open={newRoomOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewRoom();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0 sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{t("dialog.newRoom")}</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => { reset(); closeNewRoom(); }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        {/* Name */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder={t("placeholder.roomName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-4">
          <textarea
            className="w-full text-sm bg-transparent outline-none placeholder:text-muted-foreground/50 resize-none min-h-[80px]"
            placeholder={t("placeholder.addDescription")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {createRoom.isError ? (
            <p className="text-xs text-destructive">Failed to create room.</p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!name.trim() || createRoom.isPending}
            onClick={handleSubmit}
          >
            {createRoom.isPending ? "Creating…" : t("action.createRoom")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

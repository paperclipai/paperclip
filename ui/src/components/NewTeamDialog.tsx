import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { teamsApi } from "../api/teams";
import { useT } from "../i18n";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function NewTeamDialog() {
  const { t } = useT();
  const { newTeamOpen, closeNewTeam } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#3B82F6");

  const createTeam = useMutation({
    mutationFn: () =>
      teamsApi.create(selectedCompanyId!, {
        name: name.trim(),
        identifier: identifier.toUpperCase().trim(),
        description: description.trim() || null,
        color,
      }),
  });

  function reset() {
    setName("");
    setIdentifier("");
    setDescription("");
    setColor("#3B82F6");
  }

  async function handleSubmit() {
    if (!selectedCompanyId || !name.trim() || !identifier.trim()) return;
    try {
      const team = await createTeam.mutateAsync();
      queryClient.invalidateQueries({ queryKey: ["teams", selectedCompanyId] });
      reset();
      closeNewTeam();
      navigate(`/teams/${team.id}`);
    } catch {
      // surfaced via createTeam.isError
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
      open={newTeamOpen}
      onOpenChange={(open) => {
        if (!open) { reset(); closeNewTeam(); }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 sm:max-w-lg"
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
            <span>{t("dialog.newTeam")}</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => { reset(); closeNewTeam(); }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        {/* Name */}
        <div className="px-4 pt-4 pb-2">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder={t("placeholder.teamName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Identifier + Color */}
        <div className="px-4 pb-2 flex items-center gap-3">
          <input
            className="w-24 text-sm font-mono bg-transparent outline-none border-b border-border/50 placeholder:text-muted-foreground/50 uppercase"
            placeholder="ENG"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value.toUpperCase())}
            maxLength={5}
          />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-7 w-7 rounded cursor-pointer border-0 p-0"
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-4">
          <textarea
            className="w-full text-sm bg-transparent outline-none placeholder:text-muted-foreground/50 resize-none min-h-[60px]"
            placeholder={t("placeholder.addDescription")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {createTeam.isError ? (
            <p className="text-xs text-destructive">Failed to create team.</p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!name.trim() || !identifier.trim() || createTeam.isPending}
            onClick={handleSubmit}
          >
            {createTeam.isPending ? "Creating…" : t("action.createTeam")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

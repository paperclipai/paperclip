import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { clientsApi } from "../api/clients";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export function CreateClientDialog() {
  const { newClientOpen, closeNewClient } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [contactName, setContactName] = useState("");
  const [notes, setNotes] = useState("");

  const createClient = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      clientsApi.create(selectedCompanyId!, data),
  });

  function reset() {
    setName("");
    setEmail("");
    setPhone("");
    setContactName("");
    setNotes("");
  }

  async function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    try {
      await createClient.mutateAsync({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        contactName: contactName.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.list(selectedCompanyId) });
      reset();
      closeNewClient();
    } catch {
      // error surfaced via createClient.isError
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
      open={newClientOpen}
      onOpenChange={(open) => {
        if (!open) { reset(); closeNewClient(); }
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
            <span>New client</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => { reset(); closeNewClient(); }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        {/* Name */}
        <div className="px-4 pt-4 pb-2">
          <Input
            className="text-lg font-semibold border-0 shadow-none px-0 h-auto focus-visible:ring-0"
            placeholder="Client name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Fields */}
        <div className="px-4 pb-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Contact Name</Label>
              <Input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              placeholder="Relationship notes, context, or operator reminders..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {createClient.isError ? (
            <p className="text-xs text-destructive">Failed to create client.</p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!name.trim() || createClient.isPending}
            onClick={handleSubmit}
          >
            {createClient.isPending ? "Creating..." : "Create client"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

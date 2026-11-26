import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ResponsibilityArea, ResponsibilityWithRollup } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { responsibilitiesApi, responsibilityAreasApi } from "@/api/responsibilities";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import {
  barDraftFrom,
  buildCreateResponsibilityPayload,
  missingFieldsFromError,
  validateBarDraft,
  type BarDraft,
  type BarField,
} from "@/lib/responsibilities";
import { ResponsibilityBarFields } from "./ResponsibilityBarFields";

const NO_AREA = "";
const NEW_AREA = "__new__";

/**
 * Add a responsibility by hand: what you own, the area it sits under (an
 * existing one, a new one, or none), its bar with the kind of measure and that
 * template's inputs, and optionally where the number is now.
 */
export function AddResponsibilityDialog({
  open,
  onOpenChange,
  companyId,
  areas,
  defaultAreaId = null,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  /** Areas it can go under (archived ones are left out by the caller). */
  areas: readonly Pick<ResponsibilityArea, "id" | "title" | "status">[];
  /** Preselect this area, e.g. when adding from an area's heading. */
  defaultAreaId?: string | null;
  onCreated?: (created: ResponsibilityWithRollup) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [areaChoice, setAreaChoice] = useState<string>(NO_AREA);
  const [newAreaTitle, setNewAreaTitle] = useState("");
  const [draft, setDraft] = useState<BarDraft>(() => barDraftFrom());
  const [attempted, setAttempted] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      const checked = validateBarDraft(draft);
      if (!checked.ok) throw new Error("The form is incomplete");
      let areaId: string | null = areaChoice === NO_AREA || areaChoice === NEW_AREA ? null : areaChoice;
      if (areaChoice === NEW_AREA) {
        // An existing area with this name comes back instead of a duplicate.
        areaId = (await responsibilityAreasApi.create(companyId, { title: newAreaTitle.trim() })).id;
      }
      return responsibilitiesApi.create(companyId, buildCreateResponsibilityPayload({ title, bar: checked.value, areaId }));
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
      onCreated?.(created);
      onOpenChange(false);
    },
    onError: () => {
      // A new area may exist now even though the responsibility did not save.
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
    },
  });

  const resetCreate = create.reset;
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setAreaChoice(defaultAreaId ?? NO_AREA);
    setNewAreaTitle("");
    setDraft(barDraftFrom());
    setAttempted(false);
    resetCreate();
  }, [open, defaultAreaId, resetCreate]);

  const checked = validateBarDraft(draft);
  const serverMissing = missingFieldsFromError(create.error);
  const missing = new Set<BarField>([
    ...(attempted && !checked.ok ? checked.missing : []),
    ...serverMissing,
  ]);
  const invalid = new Set<BarField>(attempted && !checked.ok ? checked.invalid : []);
  const problems = attempted && !checked.ok ? checked.problems : undefined;
  const titleMissing = attempted && !title.trim();
  const newAreaMissing = attempted && areaChoice === NEW_AREA && !newAreaTitle.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!title.trim() || !checked.ok || (areaChoice === NEW_AREA && !newAreaTitle.trim()) || create.isPending) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Add a responsibility</DialogTitle>
            <DialogDescription>
              Something you own, with a bar for success and a number that shows whether you are meeting it.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">What do you own?</span>
            <Input
              autoFocus
              value={title}
              maxLength={200}
              placeholder="e.g. Investor pipeline"
              aria-invalid={titleMissing || undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
            {titleMissing ? <span className="text-xs text-destructive">Name what you own</span> : null}
          </label>
          <div className="flex flex-col gap-1.5 text-sm">
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-foreground">Area</span>
              <NativeSelect value={areaChoice} onChange={(event) => setAreaChoice(event.target.value)}>
                <option value={NO_AREA}>No area</option>
                {areas.map((area) => (
                  <option key={area.id} value={area.id}>{area.title}</option>
                ))}
                <option value={NEW_AREA}>New area…</option>
              </NativeSelect>
            </label>
            {areaChoice === NEW_AREA ? (
              <>
                <Input
                  aria-label="New area name"
                  value={newAreaTitle}
                  maxLength={200}
                  placeholder="e.g. Fundraising"
                  aria-invalid={newAreaMissing || undefined}
                  onChange={(event) => setNewAreaTitle(event.target.value)}
                />
                {newAreaMissing ? <span className="text-xs text-destructive">Name the new area</span> : null}
              </>
            ) : null}
          </div>
          <ResponsibilityBarFields draft={draft} onChange={setDraft} missing={missing} invalid={invalid} problems={problems} showCurrent />
          {create.error ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t add the responsibility. {describeError(create.error).body}
            </p>
          ) : null}
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add responsibility"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ResponsibilityArea, ResponsibilityWithRollup } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";

const NO_AREA = "";

/** The sentence as a title: one line, single spaces. */
function sentenceFrom(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Add a responsibility as one sentence of what must be true. It is saved as
 * the responsibility's title with no bar: how it is measured is set up later,
 * on its own page. The area is chosen already and can be changed.
 */
export function QuickAddResponsibilityDialog({
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
  defaultAreaId?: string | null;
  onCreated?: (created: ResponsibilityWithRollup) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [areaChoice, setAreaChoice] = useState<string>(NO_AREA);
  const sentence = sentenceFrom(text);
  // An area that is no longer offered (archived meanwhile) falls back to none.
  const areaId = areas.some((area) => area.id === areaChoice) ? areaChoice : NO_AREA;

  const create = useMutation({
    mutationFn: () => responsibilitiesApi.create(companyId, { title: sentence, ...(areaId ? { areaId } : {}) }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
      onCreated?.(created);
      onOpenChange(false);
    },
  });

  const resetCreate = create.reset;
  useEffect(() => {
    if (!open) return;
    setText("");
    setAreaChoice(defaultAreaId ?? NO_AREA);
    resetCreate();
  }, [open, defaultAreaId, resetCreate]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!sentence || create.isPending) return;
    create.mutate();
  };

  // The sentence is one line: Enter adds it.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New responsibility</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">What must be true?</span>
            <Textarea
              autoFocus
              rows={2}
              value={text}
              maxLength={200}
              placeholder="e.g. Every customer question gets an answer within a day."
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </label>
          {areas.length > 0 ? (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-foreground">Area</span>
              <NativeSelect value={areaId} onChange={(event) => setAreaChoice(event.target.value)}>
                <option value={NO_AREA}>No area</option>
                {areas.map((area) => (
                  <option key={area.id} value={area.id}>{area.title}</option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          {create.error ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t add the responsibility. {describeError(create.error).body}
            </p>
          ) : null}
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!sentence || create.isPending}>
              {create.isPending ? "Adding…" : "Add responsibility"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

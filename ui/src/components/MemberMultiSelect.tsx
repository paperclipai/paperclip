import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Identity } from "@/components/Identity";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface MemberMultiSelectOption {
  userId: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

export function memberOptionLabel(member: MemberMultiSelectOption): string {
  return member.name?.trim() || member.email?.trim() || member.userId;
}

/**
 * People counterpart to `AgentMultiSelect` (PAP-17835).
 *
 * The organization-grant audience editor needs a searchable, keyboard-operable,
 * selected-first people picker, and the design calls for one system component
 * rather than a feature-local audience picker — a future Teams primitive can
 * replace what feeds it without changing this API. Behaviour deliberately
 * matches `AgentMultiSelect`: pass `onSave` for a staged draft (Save/Cancel), or
 * `onChange` for live selection.
 */
export function MemberMultiSelect({
  members,
  selectedUserIds,
  onChange,
  onSave,
  loading = false,
  disabled = false,
  pending = false,
  getDescription,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "default",
  triggerFullWidth = true,
  triggerClassName,
  contentAlign = "start",
  emptyMessage = "No members yet.",
  showSelectionPreview = true,
  filterPlaceholder = "Filter people",
  onOpenChange,
}: {
  members: MemberMultiSelectOption[];
  selectedUserIds: Set<string>;
  onChange?: (next: Set<string>) => void;
  onSave?: (next: Set<string>) => void;
  loading?: boolean;
  disabled?: boolean;
  pending?: boolean;
  getDescription?: (member: MemberMultiSelectOption) => string | null | undefined;
  triggerLabel?: string;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
  triggerSize?: ComponentProps<typeof Button>["size"];
  triggerFullWidth?: boolean;
  triggerClassName?: string;
  contentAlign?: ComponentProps<typeof PopoverContent>["align"];
  emptyMessage?: string;
  showSelectionPreview?: boolean;
  filterPlaceholder?: string;
  onOpenChange?: (open: boolean) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [draftUserIds, setDraftUserIds] = useState<Set<string>>(new Set(selectedUserIds));
  const staged = Boolean(onSave);
  const workingUserIds = staged ? draftUserIds : selectedUserIds;

  useEffect(() => {
    if (open && staged) setDraftUserIds(new Set(selectedUserIds));
  }, [open, selectedUserIds, staged]);

  const normalizedFilter = filter.trim().toLowerCase();
  const filteredMembers = useMemo(
    () =>
      members
        .filter((member) => {
          const description = getDescription?.(member) ?? member.email ?? "";
          return `${memberOptionLabel(member)} ${description}`.toLowerCase().includes(normalizedFilter);
        })
        .sort((a, b) => {
          const aSelected = workingUserIds.has(a.userId);
          const bSelected = workingUserIds.has(b.userId);
          if (aSelected !== bSelected) return aSelected ? -1 : 1;
          return memberOptionLabel(a).localeCompare(memberOptionLabel(b));
        }),
    [members, getDescription, normalizedFilter, workingUserIds],
  );
  const selectedCount = selectedUserIds.size;
  const selectedMembers = members.filter((member) => selectedUserIds.has(member.userId));

  function setSelection(next: Set<string>) {
    if (staged) setDraftUserIds(next);
    else onChange?.(next);
  }

  return (
    <div className="space-y-2">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          onOpenChange?.(nextOpen);
          if (!nextOpen) setFilter("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={triggerVariant}
            size={triggerSize}
            className={cn("justify-between", triggerFullWidth && "w-full", triggerClassName)}
            disabled={disabled || pending}
          >
            <span className="flex min-w-0 items-center">
              <span className="truncate">
                {triggerLabel ?? (selectedCount === 0
                  ? "Select people"
                  : `${selectedCount} ${selectedCount === 1 ? "person" : "people"} selected`)}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align={contentAlign}>
          <div className="border-b border-border p-3">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={filterPlaceholder}
              className="h-8"
              autoFocus
            />
          </div>
          {loading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : members.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</div>
          ) : (
            <div className="max-h-60 overflow-y-auto py-1">
              {filteredMembers.map((member) => {
                const label = memberOptionLabel(member);
                const description = getDescription?.(member)
                  ?? (member.email && member.email !== label ? member.email : null);
                return (
                  <label
                    key={member.userId}
                    className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-accent/30"
                  >
                    <Checkbox
                      checked={workingUserIds.has(member.userId)}
                      aria-label={`Allow ${label}`}
                      onCheckedChange={(checked) => {
                        const next = new Set(workingUserIds);
                        if (checked) next.add(member.userId);
                        else next.delete(member.userId);
                        setSelection(next);
                      }}
                    />
                    <span className="flex min-w-0 flex-col">
                      <Identity name={label} avatarUrl={member.image ?? null} size="sm" />
                      {description ? (
                        <span className="truncate text-xs text-muted-foreground">{description}</span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
              {filteredMembers.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">No matches.</div>
              ) : null}
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {workingUserIds.size === 0 ? "No people selected" : `${workingUserIds.size} selected`}
            </span>
            <div className="flex items-center gap-2">
              {staged ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (staged) onSave?.(draftUserIds);
                  setOpen(false);
                }}
                disabled={pending}
              >
                {staged ? (pending ? "Saving…" : "Save") : "Done"}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {showSelectionPreview && selectedMembers.length > 0 ? (
        <div className="space-y-0.5">
          {selectedMembers.slice(0, 3).map((member) => (
            <div key={member.userId} className="flex items-center gap-2 px-1.5 py-1 text-sm">
              <Identity name={memberOptionLabel(member)} avatarUrl={member.image ?? null} size="sm" />
            </div>
          ))}
          {selectedMembers.length > 3 ? (
            <p className="px-1.5 pt-0.5 text-xs text-muted-foreground">
              and {selectedMembers.length - 3} more
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

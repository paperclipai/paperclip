import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ResponsibilityArea } from "@paperclipai/shared";
import { ChevronDown } from "lucide-react";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { queryKeys } from "@/lib/queryKeys";

type AreaRef = Pick<ResponsibilityArea, "id" | "title" | "status">;

/** Move a responsibility to another area (or out of every area). */
export function useMoveToArea(responsibilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (areaId: string | null) => responsibilitiesApi.update(responsibilityId, { areaId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all }),
  });
}

/**
 * The area choices as menu radio items: every area that can take it, then
 * "No area". Archived areas cannot take a responsibility, so only the current
 * one is listed when it is archived.
 */
export function AreaRadioItems({
  areas,
  value,
  onChange,
}: {
  areas: readonly AreaRef[];
  value: string | null;
  onChange: (areaId: string | null) => void;
}) {
  const choices = areas.filter((area) => area.status !== "archived" || area.id === value);
  return (
    <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(next) => onChange(next ? next : null)}>
      {choices.map((area) => (
        <DropdownMenuRadioItem key={area.id} value={area.id} disabled={area.status === "archived"}>
          {area.title}
          {area.status === "archived" ? " (archived)" : ""}
        </DropdownMenuRadioItem>
      ))}
      {choices.length > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuRadioItem value="">No area</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

/** The area a responsibility sits under, as a button that moves it. */
export function AreaControl({
  responsibilityId,
  area,
  areas,
}: {
  responsibilityId: string;
  area: AreaRef | null;
  areas: readonly AreaRef[];
}) {
  const move = useMoveToArea(responsibilityId);
  return (
    <span className="inline-flex flex-col gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={move.isPending}
            aria-label={area ? `Area: ${area.title}. Move to another area` : "No area. Choose one"}
          >
            {area ? area.title : <span className="text-muted-foreground">No area</span>}
            {area?.status === "archived" ? <span className="text-muted-foreground">(archived)</span> : null}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-(--sz-50vh) overflow-y-auto">
          <DropdownMenuLabel>Move to area</DropdownMenuLabel>
          <AreaRadioItems
            areas={area && !areas.some((candidate) => candidate.id === area.id) ? [area, ...areas] : areas}
            value={area?.id ?? null}
            onChange={(areaId) => {
              if (areaId !== (area?.id ?? null)) move.mutate(areaId);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {move.error ? (
        <span role="alert" className="text-xs text-destructive">
          Couldn’t move it. {describeError(move.error).body}
        </span>
      ) : null}
    </span>
  );
}

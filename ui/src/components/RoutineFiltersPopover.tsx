import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  defaultRoutineFilterState,
  routineDisplayStatusDescription,
  routineDisplayStatusLabel,
  routineDisplayStatusOrder,
  toggleRoutineFilterStatus,
  type RoutineFilterState,
} from "../lib/routine-filters";

export function RoutineFiltersPopover({
  state,
  onChange,
  activeFilterCount,
  buttonVariant = "ghost",
  iconOnly = false,
}: {
  state: RoutineFilterState;
  onChange: (patch: Partial<RoutineFilterState>) => void;
  activeFilterCount: number;
  buttonVariant?: "ghost" | "outline";
  iconOnly?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={buttonVariant}
          size={iconOnly ? "icon" : "sm"}
          className={`text-xs ${iconOnly ? "relative h-8 w-8 shrink-0" : ""} ${
            activeFilterCount > 0 ? "text-blue-600 dark:text-blue-400" : ""
          }`}
          title={iconOnly ? (activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter") : undefined}
        >
          <Filter className={iconOnly ? "h-3.5 w-3.5" : "h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1"} />
          {!iconOnly && (
            <span className="hidden sm:inline">
              {activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}
            </span>
          )}
          {!iconOnly && activeFilterCount > 0 ? (
            <X
              className="ml-1 hidden h-3 w-3 sm:block"
              onClick={(event) => {
                event.stopPropagation();
                onChange(defaultRoutineFilterState);
              }}
            />
          ) : null}
          {iconOnly && activeFilterCount > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Filters</span>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onChange(defaultRoutineFilterState)}
              >
                Clear
              </button>
            ) : null}
          </div>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Status</span>
            <div className="space-y-0.5">
              {routineDisplayStatusOrder.map((status) => (
                <label
                  key={status}
                  className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1 hover:bg-accent/50"
                  title={routineDisplayStatusDescription[status]}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={state.statuses.includes(status)}
                    onCheckedChange={() =>
                      onChange({ statuses: toggleRoutineFilterStatus(state.statuses, status) })
                    }
                  />
                  <span className="text-sm">{routineDisplayStatusLabel[status]}</span>
                </label>
              ))}
            </div>
            {state.statuses.length === 0 ? (
              <p className="pt-1 text-xs text-muted-foreground">Showing all routines.</p>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

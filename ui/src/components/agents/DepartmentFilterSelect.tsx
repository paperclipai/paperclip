import { AGENT_DEPARTMENT_UNASSIGNED, type AgentRosterOption } from "@/lib/agent-roster-filters";
import { useTx } from "@/i18n/tx";
import { NativeSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** A department choice that stays outside the other roster filters. */
export function DepartmentFilterSelect({
  value,
  options,
  onChange,
  className,
}: {
  value: string;
  options: readonly AgentRosterOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const tx = useTx();
  if (options.length === 0 && !value) return null;
  return (
    <NativeSelect
      aria-label={tx("Department")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn("h-9 w-full max-w-52 text-xs md:text-xs", className)}
    >
      <option value="">{tx("All departments")}</option>
      <option value={AGENT_DEPARTMENT_UNASSIGNED}>{tx("No department")}</option>
      {value && value !== AGENT_DEPARTMENT_UNASSIGNED && !options.some((option) => option.value === value) && (
        <option value={value}>{tx("Previously selected department")}</option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </NativeSelect>
  );
}

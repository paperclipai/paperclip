import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function InboxFilter<T extends string>({ label, heading, value, options, onChange, defaultLabel }: {
  label: string;
  heading: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  defaultLabel?: string;
}) {
  const selected = options.find(option => option.value === value);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm" value={value} aria-label={selected ? `${label}, ${selected.label}` : label}>
        <span className="max-w-(--sz-160px) truncate font-medium">{defaultLabel ?? selected?.label}</span>
        <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" collisionPadding={8} className="w-(--sz-260px)" aria-label={heading}>
      <DropdownMenuLabel>{heading}</DropdownMenuLabel>
      {options.map(option => <DropdownMenuItem key={option.value} aria-current={option.value === value || undefined}
        className="items-start gap-2" onSelect={() => onChange(option.value)}>
        <Check aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", value !== option.value && "opacity-0")} />
        <span className={cn("truncate", value === option.value && "font-medium")}>{option.label}</span>
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

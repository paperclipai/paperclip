import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface SidebarInfoButtonProps {
  title: string;
  info: string;
  className?: string;
  alwaysVisible?: boolean;
}

export function SidebarInfoButton({
  title,
  info,
  className,
  alwaysVisible = false,
}: SidebarInfoButtonProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${title}?`}
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 transition-opacity hover:bg-accent/50 hover:text-foreground",
            !alwaysVisible &&
              "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100",
            className,
          )}
        >
          <Info className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72">
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
          <PopoverDescription>{info}</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}

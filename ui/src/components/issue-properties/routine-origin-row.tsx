import { useQuery } from "@tanstack/react-query";
import { Repeat } from "lucide-react";
import { Link } from "@/lib/router";
import { badgeVariants } from "@/components/ui/badge";
import { routinesApi } from "../../api/routines";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { PropertyRow } from "./primitives";

export function RoutineOriginRow({ routineId }: { routineId: string }) {
  const { data: routine } = useQuery({
    queryKey: queryKeys.routines.detail(routineId),
    queryFn: () => routinesApi.get(routineId),
  });

  const title = routine?.title?.trim();
  if (!title) return null;

  return (
    <PropertyRow label="Routine">
      <Link
        to={`/routines/${routineId}`}
        className={cn(
          badgeVariants({ variant: "outline" }),
          "min-w-0 max-w-full shrink font-normal no-underline hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
        )}
        title={title}
      >
        <Repeat className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
      </Link>
    </PropertyRow>
  );
}

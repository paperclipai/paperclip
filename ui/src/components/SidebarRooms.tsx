import { useState } from "react";
import { NavLink } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, MessageSquare } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { roomsApi } from "../api/rooms";
import { cn } from "../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function SidebarRooms() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();

  const { data: rooms } = useQuery({
    queryKey: ["rooms", selectedCompanyId],
    queryFn: () => roomsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5_000,
  });

  if (!selectedCompanyId) return null;
  const visible = (rooms ?? []).filter((r) => r.status !== "archived");

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90",
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Rooms
            </span>
          </CollapsibleTrigger>
          <NavLink
            to="/rooms/new"
            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="New room"
          >
            <Plus className="h-3 w-3" />
          </NavLink>
        </div>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 mt-0.5">
          {visible.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-muted-foreground/60 italic flex items-center gap-2">
              <MessageSquare className="h-3 w-3" />
              No rooms yet
            </div>
          ) : (
            visible.map((room) => (
              <NavLink
                key={room.id}
                to={`/rooms/${room.id}`}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 truncate">{room.name}</span>
              </NavLink>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

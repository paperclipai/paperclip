import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, User } from "lucide-react";
import { authApi, type AuthSession } from "../api/auth";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function UserMenu() {
  const queryClient = useQueryClient();

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: health?.deploymentMode === "authenticated",
    retry: false,
  });

  if (health?.deploymentMode !== "authenticated" || !session) return null;

  const userName = session.user.name || session.user.email || "User";
  const userEmail = session.user.email;
  const initials = deriveInitials(userName);

  const handleSignOut = async () => {
    try {
      await authApi.signOut();
    } catch {
      // Continue with local cleanup even if server sign-out fails
    }
    queryClient.clear();
    window.location.href = "/auth";
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground shrink-0">
              <Avatar size="xs">
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{userName}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium leading-none">{userName}</p>
            {userEmail && (
              <p className="text-xs leading-none text-muted-foreground">{userEmail}</p>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} className="text-destructive focus:text-destructive">
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

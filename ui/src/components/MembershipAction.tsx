import type { MouseEvent } from "react";
import { Loader2, LogIn, LogOut } from "lucide-react";
import type { ResourceMembershipState } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { useLocalizedCopy } from "../i18n/ui-copy";

interface MembershipActionProps {
  state: ResourceMembershipState;
  resourceName: string;
  pending?: boolean;
  pendingState?: ResourceMembershipState | null;
  compact?: boolean;
  onJoin: () => void;
  onLeave: () => void;
}

export function MembershipAction({
  state,
  resourceName,
  pending = false,
  pendingState = null,
  compact = false,
  onJoin,
  onLeave,
}: MembershipActionProps) {
  const copy = useLocalizedCopy();
  const isLeft = state === "left";
  const label = pending
    ? pendingState === "left"
      ? copy("membership.leaving", "Leaving...", "나가는 중...")
      : copy("membership.joining", "Joining...", "참여 중...")
    : isLeft
      ? copy("membership.join", "Join", "참여")
      : copy("membership.leave", "Leave", "나가기");
  const ariaLabel = isLeft
    ? copy("membership.joinResource", "Join {{resourceName}}", "{{resourceName}} 참여", { resourceName })
    : copy("membership.leaveResource", "Leave {{resourceName}}", "{{resourceName}} 나가기", { resourceName });
  const Icon = pending ? Loader2 : isLeft ? LogIn : LogOut;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    if (isLeft) onJoin();
    else onLeave();
  }

  return (
    <span
      className={cn(
        "flex w-[66px] shrink-0 justify-end",
        !isLeft && !compact
          ? "opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          : "opacity-100",
      )}
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={ariaLabel}
        aria-busy={pending ? "true" : undefined}
        disabled={pending}
        onClick={handleClick}
        className="w-[66px]"
      >
        <Icon className={cn("h-3 w-3", pending && "motion-safe:animate-spin")} />
        <span>{label}</span>
      </Button>
    </span>
  );
}

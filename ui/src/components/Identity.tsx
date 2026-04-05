import { cn } from "@/lib/utils";
import { Avatar } from "@heroui/react";

type IdentitySize = "xs" | "sm" | "default" | "lg";

export interface IdentityProps {
  name: string;
  avatarUrl?: string | null;
  initials?: string;
  size?: IdentitySize;
  className?: string;
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const textSize: Record<IdentitySize, string> = {
  xs: "text-sm",
  sm: "text-xs",
  default: "text-sm",
  lg: "text-sm",
};

const avatarSize: Record<IdentitySize, "sm" | "md" | "lg"> = {
  xs: "sm",
  sm: "sm",
  default: "md",
  lg: "lg",
};

export function Identity({ name, avatarUrl, initials, size = "default", className }: IdentityProps) {
  const displayInitials = initials ?? deriveInitials(name);

  return (
    <span className={cn("inline-flex gap-1.5", size === "xs" ? "items-baseline gap-1" : "items-center", size === "lg" && "gap-2", className)}>
      <Avatar
        size={avatarSize[size]}
        className={size === "xs" ? "relative -top-px" : undefined}
      >
        {avatarUrl && <Avatar.Image src={avatarUrl} />}
        <Avatar.Fallback>{displayInitials}</Avatar.Fallback>
      </Avatar>
      <span className={cn("truncate", textSize[size])}>{name}</span>
    </span>
  );
}

import { cn } from "../lib/utils";

interface KiroLogoIconProps {
  className?: string;
}

export function KiroLogoIcon({ className }: KiroLogoIconProps) {
  return (
    <>
      <img
        src="/brands/kiro-logo-light.svg"
        alt="Kiro"
        className={cn("dark:hidden", className)}
      />
      <img
        src="/brands/kiro-logo-dark.svg"
        alt="Kiro"
        className={cn("hidden dark:block", className)}
      />
    </>
  );
}

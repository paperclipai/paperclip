import { cn } from "../lib/utils";

interface CodeBuddyLogoIconProps {
  className?: string;
}

export function CodeBuddyLogoIcon({ className }: CodeBuddyLogoIconProps) {
  return (
    <img
      src="/brands/codebuddy-logo.svg"
      alt="CodeBuddy"
      className={cn(className)}
    />
  );
}

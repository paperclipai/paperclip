import { cn } from "../lib/utils";

interface AmpLogoIconProps {
  className?: string;
}

export function AmpLogoIcon({ className }: AmpLogoIconProps) {
  return <img src="/brands/amp-logo-color.svg" alt="Amp" className={cn(className)} />;
}

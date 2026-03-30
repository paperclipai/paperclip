import { cn } from "../lib/utils";

interface HermesIconProps {
  className?: string;
}

/**
 * Hermes caduceus icon — winged staff with two intertwined serpents.
 * Replaces the generic Zap icon for the hermes_local adapter type.
 *
 * ⚕️ inspired but as the proper caduceus (Hermes' symbol): staff + two snakes + wings.
 */
export function HermesIcon({ className }: HermesIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(className)}
    >
      {/* Central staff */}
      <line x1="12" y1="6" x2="12" y2="23" />
      {/* Left serpent curves */}
      <path d="M12 8 C10 9 9.5 11 10.5 13 C11.5 15 10 17 12 18" />
      {/* Right serpent curves */}
      <path d="M12 8 C14 9 14.5 11 13.5 13 C12.5 15 14 17 12 18" />
      {/* Snake heads facing outward */}
      <circle cx="10" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14" cy="8" r="0.8" fill="currentColor" stroke="none" />
      {/* Wings at top of staff */}
      <path d="M12 6 L8 3 L6 5 L9 6" strokeWidth="1.2" />
      <path d="M12 6 L16 3 L18 5 L15 6" strokeWidth="1.2" />
      {/* Wing feather details */}
      <line x1="7.5" y1="4" x2="7" y2="5.2" strokeWidth="1" />
      <line x1="16.5" y1="4" x2="17" y2="5.2" strokeWidth="1" />
      {/* Staff sphere at top */}
      <circle cx="12" cy="6.5" r="1.2" />
    </svg>
  );
}
